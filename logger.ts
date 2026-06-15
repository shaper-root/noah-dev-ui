import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

const LOG_PATH = join(import.meta.dir, "logs", "agent.log");

let dirReady = false;

function ensureDir(): void {
  if (dirReady) return;
  const dir = dirname(LOG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  dirReady = true;
}

export type LogLevel = "info" | "warn" | "error";

interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  cid?: string;
  [key: string]: unknown;
}

export function log(
  level: LogLevel,
  event: string,
  data?: Record<string, unknown>,
): void {
  try {
    ensureDir();
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...data,
    };
    appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // logging must never crash the agent
  }
}
