import { resolve } from "path";

const env = (key: string, fallback: string): string =>
  process.env[key] || fallback;

const envBool = (key: string, fallback: boolean): boolean => {
  const val = process.env[key];
  if (val === undefined || val === "") return fallback;
  return val !== "false" && val !== "0";
};

const envInt = (key: string, fallback: number): number => {
  const val = process.env[key];
  if (!val) return fallback;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
};

export const config = {
  provider: (() => {
    const mode = env("NOAH_MODEL_MODE", env("NOAH_PROVIDER", "local"));
    return mode === "cloud" ? "cloud" : "local";
  })() as "local" | "cloud",

  ollama: {
    url: env("OLLAMA_URL", "http://127.0.0.1:11434"),
    model: env("NOAH_MODEL", "qwen3.5:4b"),
    numCtx: envInt("NOAH_NUM_CTX", 12288),
    timeoutMs: envInt("NOAH_TIMEOUT_MS", 120_000),
  },

  cloud: {
    url: env("NOAH_CLOUD_URL", "https://api.fireworks.ai/inference/v1"),
    key: env("FIREWORKS_API_KEY", env("NOAH_CLOUD_KEY", "")),
    model: env("NOAH_CLOUD_MODEL", "accounts/fireworks/models/qwen3p6-plus"),
    promptCache: (process.env.FIREWORKS_PROMPT_CACHE || "false") === "true",
    timeoutMs: envInt("NOAH_CLOUD_TIMEOUT_MS", 60_000),
    // Bound the cloud completion. Reasoning models (e.g. qwen3p6-plus) emit long
    // hidden reasoning; without a cap a single round can run ~50s and a multi-round
    // turn blows the timeout. 0 = omit (provider default).
    maxTokens: envInt("NOAH_CLOUD_MAX_TOKENS", 2048),
    // Controls hidden reasoning for reasoning-capable cloud models. "none" disables
    // it (~1s responses, verified for qwen3p6-plus on Fireworks) — the reliability
    // default. Set "low"/"medium"/"high" for deeper reasoning (raise
    // NOAH_CLOUD_TIMEOUT_MS to match), or "" to omit the param (provider default).
    reasoningEffort: env("NOAH_CLOUD_REASONING_EFFORT", "none"),
  },

  memory: {
    userId: env("MEMORY_USER_ID", ""),
    sqlitePath: env("SQLITE_PATH", ""),
    memoryApiDir: env("NOAH_MEMORY_API_DIR", ""),
  },

  // Okeanos behavioral kernel (P2). The kernel text is read at startup from
  // skillforge's deploy directory — NO copy lives in this repo, so `forge deploy`
  // updates what Noah loads on next restart. All settings are new env vars; nothing
  // here changes existing behavior when NOAH_KERNEL_ENABLED is left at its default.
  kernel: {
    // Master switch. false → passthrough (no kernel text injected), identical to
    // pre-P2 behavior.
    enabled: envBool("NOAH_KERNEL_ENABLED", true),
    // full → reasoning-kernel.md (cloud). lite → reasoning-kernel-lite.md (local 4B).
    // none → passthrough A/B baseline.
    tier: env("NOAH_KERNEL_TIER", "full") as "full" | "lite" | "none",
    // Read straight from skillforge's deploy bundles (sibling of the Noah repo).
    path: env(
      "KERNEL_PATH",
      resolve(import.meta.dir, "../../skillforge/deploy/bundles/reasoning-kernel.md"),
    ),
    litePath: env(
      "KERNEL_LITE_PATH",
      resolve(import.meta.dir, "../../skillforge/deploy/bundles/reasoning-kernel-lite.md"),
    ),
  },

  // Obsidian vault read access (P2). READ-ONLY: Noah reads Root's curated notes on
  // demand; it never writes to the vault and never auto-imports vault content into
  // memory. Sensitive subtrees are excluded by default (IP boundary).
  vault: {
    enabled: envBool("NOAH_VAULT_ENABLED", true),
    path: env("NOAH_VAULT_PATH", "C:\\Users\\MyOme\\OneDrive\\Documents\\RootCellar2"),
    // Directory names (any depth) excluded from all vault access. `.obsidian` is the
    // app's own config; `06-sensitive` is IP-sensitive. Anything matching "shannon"
    // is hard-blocked in code regardless of this list.
    exclude: env("NOAH_VAULT_EXCLUDE", ".obsidian,06-sensitive,_raw")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Vault content trust: Root's curated notes (above conversation 0.85, below seed 1.0).
    trust: 0.9,
    maxFileBytes: envInt("NOAH_VAULT_MAX_FILE_BYTES", 200_000),
    maxResults: envInt("NOAH_VAULT_MAX_RESULTS", 8),
    snippetChars: envInt("NOAH_VAULT_SNIPPET_CHARS", 240),
  },

  webSearch: {
    provider: env("NOAH_WEB_SEARCH_PROVIDER", "stub") as "stub" | "ddg",
  },

  maxToolRounds: envInt("NOAH_MAX_TOOL_ROUNDS", 3),
  mcpToolTimeoutMs: envInt("NOAH_MCP_TOOL_TIMEOUT_MS", 15_000),
  maxContextChars: envInt("NOAH_MAX_CONTEXT_CHARS", 40_000),
  shortUtteranceThreshold: 5,
};

export function validateConfig(): void {
  if (!config.memory.userId) {
    console.error("[noah] MEMORY_USER_ID env var is required");
    process.exit(1);
  }

  if (config.provider === "cloud" && !config.cloud.key) {
    console.warn(
      "[noah] FIREWORKS_API_KEY not set — cloud requests will fail until configured",
    );
  }

  console.log(`[noah] Mode: ${config.provider}`);
  console.log(
    `[noah] Model: ${config.provider === "local" ? config.ollama.model : config.cloud.model}`,
  );
  if (config.provider === "local") {
    console.log(`[noah] Ollama: ${config.ollama.url}`);
    console.log(`[noah] Context: ${config.ollama.numCtx}`);
  } else {
    console.log(`[noah] Cloud URL: ${config.cloud.url}`);
    console.log(`[noah] Prompt cache: ${config.cloud.promptCache}`);
  }
  console.log(`[noah] Memory user: ${config.memory.userId}`);
  console.log(`[noah] Web search: ${config.webSearch.provider}`);
  console.log(
    `[noah] Kernel: ${config.kernel.enabled ? config.kernel.tier : "disabled"}`,
  );
  console.log(
    `[noah] Vault: ${config.vault.enabled ? config.vault.path : "disabled"}`,
  );
}
