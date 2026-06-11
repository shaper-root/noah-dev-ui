const env = (key: string, fallback: string): string =>
  process.env[key] || fallback;

const envInt = (key: string, fallback: number): number => {
  const val = process.env[key];
  if (!val) return fallback;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
};

export const config = {
  provider: env("NOAH_PROVIDER", "local") as "local" | "cloud",

  ollama: {
    url: env("OLLAMA_URL", "http://127.0.0.1:11434"),
    model: env("NOAH_MODEL", "qwen3.5:4b"),
    numCtx: envInt("NOAH_NUM_CTX", 12288),
    timeoutMs: envInt("NOAH_TIMEOUT_MS", 120_000),
  },

  cloud: {
    url: env("NOAH_CLOUD_URL", ""),
    key: env("NOAH_CLOUD_KEY", ""),
    model: env("NOAH_CLOUD_MODEL", ""),
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

  if (config.provider !== "local" && config.provider !== "cloud") {
    console.error(
      `[noah] NOAH_PROVIDER must be 'local' or 'cloud', got '${config.provider}'`,
    );
    process.exit(1);
  }

  if (config.provider === "cloud") {
    if (!config.cloud.url) {
      console.error("[noah] NOAH_CLOUD_URL required when NOAH_PROVIDER=cloud");
      process.exit(1);
    }
    if (!config.cloud.key) {
      console.error("[noah] NOAH_CLOUD_KEY required when NOAH_PROVIDER=cloud");
      process.exit(1);
    }
    if (!config.cloud.model) {
      console.error(
        "[noah] NOAH_CLOUD_MODEL required when NOAH_PROVIDER=cloud",
      );
      process.exit(1);
    }
  }

  console.log(`[noah] Provider: ${config.provider}`);
  console.log(
    `[noah] Model: ${config.provider === "local" ? config.ollama.model : config.cloud.model}`,
  );
  if (config.provider === "local") {
    console.log(`[noah] Ollama: ${config.ollama.url}`);
    console.log(`[noah] Context: ${config.ollama.numCtx}`);
  }
  console.log(`[noah] Memory user: ${config.memory.userId}`);
  console.log(`[noah] Web search: ${config.webSearch.provider}`);
}
