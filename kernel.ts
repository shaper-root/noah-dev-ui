/**
 * Okeanos behavioral kernel loader (P2).
 *
 * Reads the kernel text from skillforge's deploy bundle at startup and injects it
 * between Noah's system prompt and the recalled-memory context. The kernel shapes
 * HOW Noah thinks (push back, surface assumptions, calibrate confidence); memory is
 * WHAT it knows. This loader is separate from `kernel-seam.ts`, which reshapes the
 * memory objects themselves and remains passthrough.
 *
 * Design notes:
 *  - The kernel file lives in skillforge, not this repo. `forge deploy` updates it;
 *    Noah picks up the change on next restart. No copying, no version sync.
 *  - Graceful fallback: a missing/unreadable file (wrong path, skillforge not
 *    deployed, lite kernel not yet authored) logs a warning and degrades to
 *    passthrough. The agent never crashes over a kernel problem.
 *  - Version and token count are read from the file at load time — nothing about the
 *    kernel's size or version is hardcoded here, so a recompiled kernel is reflected
 *    automatically.
 */

import { readFileSync } from "fs";
import { config } from "./config";
import { log } from "./logger";

export interface KernelLoad {
  /** Whether kernel text will actually be injected this run. */
  active: boolean;
  /** Resolved tier (full | lite | none). `none`/disabled/fallback → not active. */
  tier: "full" | "lite" | "none";
  /** Kernel body to inject. Empty string when not active. */
  text: string;
  /** Version parsed from the first `# Reasoning Kernel vX.Y.Z` line, or "none". */
  version: string;
  /** Rough token estimate (chars / 4) of the injected text. 0 when not active. */
  tokenEstimate: number;
  /** Resolved source path, or "passthrough" when not active. */
  source: string;
}

const PASSTHROUGH: KernelLoad = {
  active: false,
  tier: "none",
  text: "",
  version: "none",
  tokenEstimate: 0,
  source: "passthrough",
};

let cached: KernelLoad | null = null;

function parseVersion(text: string): string {
  // First non-empty content line is expected to be `# Reasoning Kernel v1.2.0 ...`.
  const match = text.match(/^#\s*Reasoning Kernel\s+(v[^\s#]+)/m);
  return match ? match[1] : "unknown";
}

function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

/**
 * Load (and cache) the kernel per current config. Never throws.
 *
 * Resolution:
 *   enabled=false OR tier=none → passthrough.
 *   tier=full → KERNEL_PATH. tier=lite → KERNEL_LITE_PATH.
 *   file missing/empty → warn + passthrough.
 */
export function loadKernel(): KernelLoad {
  if (cached) return cached;

  if (!config.kernel.enabled || config.kernel.tier === "none") {
    log("info", "kernel.disabled", {
      enabled: config.kernel.enabled,
      tier: config.kernel.tier,
    });
    cached = PASSTHROUGH;
    return cached;
  }

  const tier = config.kernel.tier;
  const path = tier === "lite" ? config.kernel.litePath : config.kernel.path;

  let text: string;
  try {
    text = readFileSync(path, "utf-8").trim();
  } catch (err) {
    console.warn(
      `[kernel] Could not read ${tier} kernel at ${path} — falling back to passthrough:`,
      err instanceof Error ? err.message : String(err),
    );
    log("warn", "kernel.load_fail", {
      tier,
      path,
      err: err instanceof Error ? err.message : String(err),
    });
    cached = PASSTHROUGH;
    return cached;
  }

  if (!text) {
    console.warn(`[kernel] ${tier} kernel at ${path} is empty — passthrough.`);
    log("warn", "kernel.empty", { tier, path });
    cached = PASSTHROUGH;
    return cached;
  }

  const version = parseVersion(text);
  const tokenEstimate = estimateTokens(text);
  cached = { active: true, tier, text, version, tokenEstimate, source: path };

  console.log(
    `[kernel] Loaded ${tier} kernel ${version} (~${tokenEstimate} tokens) from ${path}`,
  );
  log("info", "kernel.loaded", { tier, version, tokenEstimate, source: path });
  return cached;
}

/** Test hook: drop the cache so the next loadKernel() re-reads config + disk. */
export function resetKernelCache(): void {
  cached = null;
}
