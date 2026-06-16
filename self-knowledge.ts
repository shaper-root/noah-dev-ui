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
import { resolve } from "path";
import { config } from "./config";
import { log } from "./logger";

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
}

const PASSTHROUGH: SelfKnowledgeLoad = {
  active: false,
  text: "",
  tokenEstimate: 0,
  source: "passthrough",
  mtime: "none",
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
  cached = { active: true, text, tokenEstimate, source: path, mtime };

  console.log(
    `[self-knowledge] Loaded ${FILENAME} (~${tokenEstimate} tokens) from ${path}`,
  );
  log("info", "selfknowledge.loaded", {
    source: path,
    tokens: tokenEstimate,
    mtime,
  });
  return cached;
}

/** Test hook: drop the cache so the next loadSelfKnowledge() re-reads. */
export function resetSelfKnowledgeCache(): void {
  cached = null;
}
