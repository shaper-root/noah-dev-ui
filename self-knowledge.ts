/**
 * Self-knowledge loader (Phase 5).
 *
 * Reads `Noah-Self-Knowledge.md` from the configured Obsidian vault at session
 * startup and injects its contents between the kernel block and the recalled-
 * memory block. The vault note is human-authored — a behavioral mirror that
 * Noah uses to compensate for known failure patterns (silent memory stores,
 * false-premise acceptance, hallucinated capabilities).
 *
 * Cached per-process. Editing the vault file updates Noah on next restart;
 * `resetSelfKnowledgeCache()` lets tests drop the cache without restarting.
 *
 * Graceful fallback: missing file, disabled vault, or read error → passthrough
 * (no injection, no crash). The agent never depends on this being present.
 */

import { readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { resolve } from "path";
import { config } from "./config";
import { log } from "./logger";

/**
 * Hard cap on the self-knowledge file size. The file is injected into the
 * system prompt as instruction (no spotlighting fence) — an unbounded read
 * would let a vault corruption or a malicious sync conflict balloon the
 * system message and either OOM the model call or smuggle large prompt
 * payloads. 32KB is generous for a behavioral mirror (current note is ~4KB)
 * and tight enough that surprise growth is caught.
 */
const MAX_FILE_BYTES = 32 * 1024;

export interface SelfKnowledgeLoad {
  /** Whether the text will actually be injected this run. */
  active: boolean;
  /** Body to inject. Empty string when not active. */
  text: string;
  /** Rough token estimate (chars / 4). 0 when not active. */
  tokenEstimate: number;
  /** Resolved source path, or "passthrough" when not active. */
  source: string;
  /** File mtime when loaded — exposed for debugging stale caches. */
  mtime: string;
  /** SHA-256 of the loaded text. Logged at load so any unauthorized
   *  mid-session change shows up as a hash drift in the forensic trail. */
  sha256: string;
}

const PASSTHROUGH: SelfKnowledgeLoad = {
  active: false,
  text: "",
  tokenEstimate: 0,
  source: "passthrough",
  mtime: "none",
  sha256: "none",
};

const FILENAME = "Noah-Self-Knowledge.md";

let cached: SelfKnowledgeLoad | null = null;

function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

/**
 * Load (and cache) the self-knowledge note per current vault config. Never
 * throws. Returns PASSTHROUGH when the vault is disabled, the file is missing,
 * or the read fails for any reason.
 */
export function loadSelfKnowledge(): SelfKnowledgeLoad {
  if (cached) return cached;

  if (!config.vault.enabled) {
    cached = PASSTHROUGH;
    return cached;
  }

  const path = resolve(config.vault.path, FILENAME);

  let text: string;
  let mtime: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      log("info", "selfknowledge.not_file", { path });
      cached = PASSTHROUGH;
      return cached;
    }
    // Hard cap (cso M1): refuse files larger than MAX_FILE_BYTES so a vault
    // corruption / malicious sync conflict can't blow up the system prompt.
    if (stat.size > MAX_FILE_BYTES) {
      console.warn(
        `[self-knowledge] ${FILENAME} is ${stat.size} bytes, exceeds ${MAX_FILE_BYTES} cap — refusing to load.`,
      );
      log("warn", "selfknowledge.oversize", {
        path,
        size: stat.size,
        cap: MAX_FILE_BYTES,
      });
      cached = PASSTHROUGH;
      return cached;
    }
    text = readFileSync(path, "utf-8").trim();
    mtime = stat.mtime.toISOString();
  } catch (err) {
    log("info", "selfknowledge.missing", {
      path,
      err: err instanceof Error ? err.message : String(err),
    });
    cached = PASSTHROUGH;
    return cached;
  }

  if (!text) {
    log("info", "selfknowledge.empty", { path });
    cached = PASSTHROUGH;
    return cached;
  }

  const tokenEstimate = estimateTokens(text);
  const sha256 = createHash("sha256").update(text).digest("hex");
  cached = { active: true, text, tokenEstimate, source: path, mtime, sha256 };

  console.log(
    `[self-knowledge] Loaded ${FILENAME} (~${tokenEstimate} tokens, sha256=${sha256.slice(0, 12)}…) from ${path}`,
  );
  // sha256 in the structured log lets the session-review agent detect
  // unauthorized mid-session vault edits as a hash drift in the trail.
  log("info", "selfknowledge.loaded", {
    source: path,
    tokens: tokenEstimate,
    mtime,
    sha256,
  });
  return cached;
}

/** Test hook: drop the cache so the next loadSelfKnowledge() re-reads. */
export function resetSelfKnowledgeCache(): void {
  cached = null;
}
