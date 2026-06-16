/**
 * Obsidian vault read access (P2).
 *
 * Gives Noah READ-ONLY access to Root's curated Obsidian vault (RootCellar2). The
 * agent reads notes on demand via the vault_search / vault_read tools — it never
 * writes, and vault content is never auto-imported into memory.
 *
 * Security posture:
 *  - READ-ONLY by construction: this module exposes no write/delete path.
 *  - Path-jailed: every resolved path must stay within the configured vault root;
 *    traversal (`../`, absolute paths) is rejected.
 *  - Excluded subtrees: directory names in config.vault.exclude (default
 *    `.obsidian`, `06-sensitive`, `_raw`) are invisible to search and read.
 *  - Hard IP block: any path containing "shannon" (case-insensitive) is refused
 *    regardless of the exclude list (CLAUDE.md Shannon boundary).
 *  - Size-capped reads (config.vault.maxFileBytes).
 *
 * Trust: vault content is labeled at config.vault.trust (0.9) — above conversation
 * memories (0.85), below seed (1.0). See data-boundary.wrapVaultAsData.
 */

import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from "fs";
import { resolve, relative, sep, extname } from "path";
import { config } from "./config";
import { log } from "./logger";

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

// Hard-excluded directory names that the env-configured exclude list can never
// remove. Guarantees the IP-sensitive subtree and Obsidian's own config stay
// invisible even if NOAH_VAULT_EXCLUDE is misconfigured or emptied.
const ALWAYS_EXCLUDE = new Set([".obsidian", "06-sensitive"]);

// Backstop against an adversarial/huge vault (or a symlink loop) exhausting the
// walk. Hitting the cap is logged, never silent.
const WALK_FILE_CAP = 20_000;

export interface VaultFile {
  /** Vault-relative path with forward slashes (stable across platforms). */
  path: string;
  bytes: number;
}

export interface VaultSearchHit {
  path: string;
  snippet: string;
  score: number;
}

export interface VaultStats {
  fileCount: number;
  totalBytes: number;
}

function vaultRoot(): string {
  return resolve(config.vault.path);
}

/**
 * Canonical (symlink-resolved) vault root. Used to re-validate the jail after
 * symlink resolution. Falls back to the plain resolved path if realpath fails.
 */
function canonicalRoot(): string {
  try {
    return realpathSync(vaultRoot());
  } catch {
    return vaultRoot();
  }
}

/** Re-check a resolved real path against the canonical root + exclusions. */
function withinJail(realPath: string, root: string): boolean {
  const rel = relative(root, realPath);
  if (rel === "" || rel.startsWith("..")) return false;
  if (resolve(root, rel) !== realPath) return false;
  if (isShannon(rel)) return false;
  if (rel.split(sep).some(segmentExcluded)) return false;
  return true;
}

/** True if the vault is configured and the root directory actually exists on disk. */
export function vaultAvailable(): boolean {
  return config.vault.enabled && existsSync(vaultRoot());
}

/** Normalize a relative path to forward slashes for stable display/keys. */
function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** A path segment is excluded if it's in the hard set or the configured list. */
function segmentExcluded(name: string): boolean {
  const lower = name.toLowerCase();
  if (ALWAYS_EXCLUDE.has(lower)) return true;
  return config.vault.exclude.some((ex) => ex.toLowerCase() === lower);
}

/** Hard IP block: never expose anything Shannon-related, whatever the exclude list. */
function isShannon(relPath: string): boolean {
  return relPath.toLowerCase().includes("shannon");
}

/**
 * Resolve a caller-supplied vault-relative path to an absolute path, enforcing the
 * jail + exclusions. Returns null if the path escapes the vault, is excluded, is
 * Shannon-related, or doesn't exist as a file.
 */
function safeResolve(relPath: string): string | null {
  if (!relPath || typeof relPath !== "string") return null;
  // Reject absolute paths and drive letters outright.
  if (/^(?:[a-zA-Z]:)?[\\/]/.test(relPath)) return null;

  const root = canonicalRoot();
  const abs = resolve(vaultRoot(), relPath);

  // Cheap lexical jail check before touching disk.
  const lexicalRel = relative(vaultRoot(), abs);
  if (lexicalRel === "" || lexicalRel.startsWith("..")) return null;

  if (!existsSync(abs)) return null;

  // Resolve symlinks and re-validate against the canonical root: statSync (and
  // readFileSync) FOLLOW symlinks, so without this a symlink inside the vault
  // pointing outside it would be readable. realpathSync canonicalizes the target.
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return null;
  }
  if (!withinJail(real, root)) return null;

  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

/**
 * Recursively walk the vault, honoring exclusions and the Shannon hard block.
 * `root` is the CANONICAL (realpath-resolved) vault root; every entry is itself
 * realpath-resolved and re-validated against it before recursion/listing, so a
 * symlink or Windows junction inside the vault cannot escape the jail (Dirent
 * type flags can report a reparse-point target's type).
 */
function walk(dir: string, root: string, acc: VaultFile[]): void {
  if (acc.length >= WALK_FILE_CAP) return;
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (acc.length >= WALK_FILE_CAP) {
      log("warn", "vault.walk.capped", { cap: WALK_FILE_CAP });
      return;
    }
    const name = entry.name;
    if (segmentExcluded(name)) continue;
    const abs = resolve(dir, name);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      continue;
    }
    if (!withinJail(real, root)) continue;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(real);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(real, root, acc);
    } else if (st.isFile() && TEXT_EXTENSIONS.has(extname(name).toLowerCase())) {
      acc.push({ path: toPosix(relative(root, real)), bytes: st.size });
    }
  }
}

/** List all accessible text files in the vault (excluded subtrees omitted). */
export function listVaultFiles(): VaultFile[] {
  if (!vaultAvailable()) return [];
  const root = canonicalRoot();
  const acc: VaultFile[] = [];
  walk(root, root, acc);
  acc.sort((a, b) => a.path.localeCompare(b.path));
  return acc;
}

export function vaultStats(): VaultStats {
  const files = listVaultFiles();
  return {
    fileCount: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
  };
}

/** Build a short snippet around the first query-term hit (or file head). */
function makeSnippet(content: string, terms: string[]): string {
  const max = config.vault.snippetChars;
  const lower = content.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const found = lower.indexOf(t);
    if (found !== -1 && (idx === -1 || found < idx)) idx = found;
  }
  const start = idx === -1 ? 0 : Math.max(0, idx - 40);
  return content
    .slice(start, start + max)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Search the vault by filename + content. Simple term-frequency scoring (filename
 * matches weighted higher) — adequate for a small vault; Track 2 covers scaling to
 * a real index/retrieval pipeline. Returns up to config.vault.maxResults hits.
 */
export function searchVault(query: string): VaultSearchHit[] {
  if (!vaultAvailable()) return [];
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (!terms.length) return [];

  const files = listVaultFiles();
  const hits: VaultSearchHit[] = [];

  for (const f of files) {
    if (f.bytes > config.vault.maxFileBytes) continue;
    // Re-validate through the full jail (realpath + exclusions) before reading,
    // as defense-in-depth against any TOCTOU between listing and read.
    const abs = safeResolve(f.path.split("/").join(sep));
    if (!abs) continue;
    let content: string;
    try {
      content = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const haystackName = f.path.toLowerCase();
    const haystackBody = content.toLowerCase();

    let score = 0;
    for (const t of terms) {
      if (haystackName.includes(t)) score += 5;
      let from = 0;
      let count = 0;
      while (count < 50) {
        const at = haystackBody.indexOf(t, from);
        if (at === -1) break;
        count++;
        from = at + t.length;
      }
      score += count;
    }
    if (score > 0) {
      hits.push({ path: f.path, snippet: makeSnippet(content, terms), score });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const limited = hits.slice(0, config.vault.maxResults);
  log("info", "vault.search", { q: query.slice(0, 80), hits: limited.length });
  return limited;
}

export interface VaultReadResult {
  ok: boolean;
  path?: string;
  content?: string;
  truncated?: boolean;
  error?: string;
}

/** Read one vault file. Path-jailed, excluded-aware, size-capped. Never throws. */
export function readVaultFile(relPath: string): VaultReadResult {
  if (!vaultAvailable()) {
    return { ok: false, error: "Vault is not available." };
  }
  const abs = safeResolve(relPath);
  if (!abs) {
    log("warn", "vault.read.denied", { path: String(relPath).slice(0, 120) });
    return {
      ok: false,
      error:
        "Path not found or not accessible (it may be outside the vault, excluded, or doesn't exist).",
    };
  }
  try {
    const buf = readFileSync(abs);
    const cap = config.vault.maxFileBytes;
    const truncated = buf.length > cap;
    const content = buf.subarray(0, cap).toString("utf-8");
    const rel = toPosix(relative(vaultRoot(), abs));
    log("info", "vault.read", { path: rel, bytes: buf.length, truncated });
    return { ok: true, path: rel, content, truncated };
  } catch (err) {
    return {
      ok: false,
      error: `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
