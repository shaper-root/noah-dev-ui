const env = (key: string, fallback: string): string =>
  process.env[key] || fallback;

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
  },

  memory: {
    userId: env("MEMORY_USER_ID", ""),
    sqlitePath: env("SQLITE_PATH", ""),
    memoryApiDir: env("NOAH_MEMORY_API_DIR", ""),
  },

  webSearch: {
    provider: env("NOAH_WEB_SEARCH_PROVIDER", "stub") as "stub" | "ddg",
  },

  maxToolRounds: 5,
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
}
