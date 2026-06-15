import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { config } from "./config";
import { log } from "./logger";

const HEALTH_RECHECK_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface RecalledMemory {
  id: string;
  content: string;
  type: string;
  category: string;
  scope: string;
  source: string;
  entities: string[];
  keywords: string[];
  confidence: number;
  created_at: string;
  score: number;
}

export interface RememberResult {
  stored: boolean;
  id: string;
  confidence: number;
  embedded: boolean;
}

export interface RecallResult {
  count: number;
  signals: Record<string, unknown>;
  totalMs: number;
  memories: RecalledMemory[];
}

function parseMcpResult(result: { content: unknown; isError?: boolean }): unknown {
  const text = Array.isArray(result.content)
    ? (result.content as Array<{ text?: string }>)
        .map((c) => c.text || "")
        .join("")
    : String(result.content);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// Bun.spawn on Windows (v1.3.11): cwd breaks executable resolution, paths with
// spaces cause ENOENT. Workaround: skip cwd, use 8.3 short paths, absolute file
// URLs for --import. See spike-mcp.ts for the proven pattern.
class BunStdioTransport implements Transport {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private buffer = "";
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  sessionId?: string;

  constructor(
    private command: string,
    private args: string[],
    private env: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    this.proc = Bun.spawn([this.command, ...this.args], {
      env: this.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    (async () => {
      if (!this.proc?.stderr) return;
      const reader = this.proc.stderr.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          process.stderr.write(`[mcp-stderr] ${decoder.decode(value)}`);
        }
      } catch {}
    })();

    (async () => {
      if (!this.proc?.stdout) return;
      const reader = this.proc.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.buffer += decoder.decode(value);
          this.processBuffer();
        }
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      }
      this.onclose?.();
    })();
  }

  private processBuffer(): void {
    while (true) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx === -1) return;

      const line = this.buffer.slice(0, newlineIdx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const message = JSONRPCMessageSchema.parse(JSON.parse(line));
        this.onmessage?.(message);
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.proc?.stdin) throw new Error("Transport not started");
    await this.proc.stdin.write(JSON.stringify(message) + "\n");
    this.proc.stdin.flush();
  }

  async close(): Promise<void> {
    this.proc?.kill();
    this.proc = null;
  }
}

class MemoryClient {
  private client: Client | null = null;
  private transport: BunStdioTransport | null = null;
  private available = true;
  private lastFail = 0;
  private connecting = false;

  async connect(): Promise<void> {
    if (this.client || this.connecting) return;
    this.connecting = true;

    try {
      const memoryApiDir =
        config.memory.memoryApiDir ||
        resolve(import.meta.dir, "../../memory-api");

      const nodeBin =
        Bun.which("node")?.replace(/Program Files/gi, "PROGRA~1") ??
        (() => {
          throw new Error("node not found in PATH");
        })();

      const tsxRegister = pathToFileURL(
        resolve(memoryApiDir, "node_modules/tsx/dist/loader.mjs"),
      ).href;

      const serverFile = resolve(memoryApiDir, "src/mcp/server.ts");
      const sqlitePath =
        config.memory.sqlitePath ||
        resolve(memoryApiDir, "data/sqlite/memory.db");

      this.transport = new BunStdioTransport(
        nodeBin,
        ["--import", tsxRegister, serverFile],
        {
          PATH: process.env.PATH ?? "",
          SYSTEMROOT: process.env.SYSTEMROOT ?? "",
          TEMP: process.env.TEMP ?? "",
          TMP: process.env.TMP ?? "",
          HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
          MEMORY_USER_ID: config.memory.userId,
          SQLITE_PATH: sqlitePath,
        },
      );

      this.client = new Client({ name: "noah-agent", version: "0.1.0" });

      this.transport.onclose = () => {
        console.warn("[memory] MCP child process exited");
        log("warn", "mcp.exit");
        this.client = null;
        this.transport = null;
        this.available = false;
        this.lastFail = Date.now();
      };

      await this.client.connect(this.transport);
      this.available = true;
      console.warn("[memory] Connected to MCP server");
      log("info", "mcp.connect");
    } catch (err) {
      console.error("[memory] Failed to connect:", err);
      log("error", "mcp.connect.fail", { err: err instanceof Error ? err.message : String(err) });
      this.client = null;
      this.transport = null;
      this.available = false;
      this.lastFail = Date.now();
      throw err;
    } finally {
      this.connecting = false;
    }
  }

  forceDisconnect(): void {
    console.warn("[memory] Force-disconnecting MCP client");
    log("warn", "mcp.force_disconnect");
    try { this.transport?.close(); } catch {}
    this.client = null;
    this.transport = null;
    this.available = false;
    this.connecting = false;
    this.lastFail = Date.now();
  }

  async ensureConnected(): Promise<boolean> {
    if (this.client) return true;
    if (this.connecting) return false;

    if (!this.available && Date.now() - this.lastFail < HEALTH_RECHECK_MS) {
      return false;
    }

    try {
      await this.connect();
      return !!this.client;
    } catch {
      return false;
    }
  }

  async recall(
    query: string,
    opts?: {
      topK?: number;
      type?: string;
      scope?: string;
      entities?: string[];
    },
  ): Promise<RecallResult> {
    const empty: RecallResult = {
      count: 0,
      signals: {},
      totalMs: 0,
      memories: [],
    };
    if (!(await this.ensureConnected())) return empty;

    try {
      const result = await withTimeout(
        this.client!.callTool({
          name: "memory_recall",
          arguments: {
            query,
            topK: opts?.topK ?? 10,
            ...(opts?.type && { type: opts.type }),
            ...(opts?.scope && { scope: opts.scope }),
            ...(opts?.entities && { entities: opts.entities }),
          },
        }),
        config.mcpToolTimeoutMs,
        "memory_recall",
      );

      if (result.isError) {
        console.warn("[memory] recall error:", parseMcpResult(result));
        return empty;
      }

      return parseMcpResult(result) as RecallResult;
    } catch (err) {
      console.warn("[memory] recall failed:", err);
      if (err instanceof Error && err.message.includes("timed out")) {
        this.forceDisconnect();
      } else {
        this.available = false;
        this.lastFail = Date.now();
      }
      return empty;
    }
  }

  async remember(
    content: string,
    opts?: {
      type?: string;
      category?: string;
      scope?: string;
      entities?: string[];
      keywords?: string[];
      supersedes?: string;
    },
  ): Promise<RememberResult | null> {
    if (!(await this.ensureConnected())) return null;

    try {
      const result = await withTimeout(
        this.client!.callTool({
          name: "memory_remember",
          arguments: {
            content,
            ...(opts?.type && { type: opts.type }),
            ...(opts?.category && { category: opts.category }),
            ...(opts?.scope && { scope: opts.scope }),
            ...(opts?.entities && { entities: opts.entities }),
            ...(opts?.keywords && { keywords: opts.keywords }),
            ...(opts?.supersedes && { supersedes: opts.supersedes }),
          },
        }),
        config.mcpToolTimeoutMs,
        "memory_remember",
      );

      if (result.isError) {
        console.warn("[memory] remember rejected:", parseMcpResult(result));
        return null;
      }

      return parseMcpResult(result) as RememberResult;
    } catch (err) {
      console.warn("[memory] remember failed:", err);
      if (err instanceof Error && err.message.includes("timed out")) {
        this.forceDisconnect();
      }
      return null;
    }
  }

  async forget(memoryId: string): Promise<Record<string, unknown> | null> {
    if (!(await this.ensureConnected())) return null;

    try {
      const result = await withTimeout(
        this.client!.callTool({
          name: "memory_forget",
          arguments: { memory_id: memoryId },
        }),
        config.mcpToolTimeoutMs,
        "memory_forget",
      );

      return parseMcpResult(result) as Record<string, unknown>;
    } catch (err) {
      console.warn("[memory] forget failed:", err);
      if (err instanceof Error && err.message.includes("timed out")) {
        this.forceDisconnect();
      }
      return null;
    }
  }

  async inspect(memoryId: string): Promise<Record<string, unknown> | null> {
    if (!(await this.ensureConnected())) return null;

    try {
      const result = await withTimeout(
        this.client!.callTool({
          name: "memory_inspect",
          arguments: { memory_id: memoryId },
        }),
        config.mcpToolTimeoutMs,
        "memory_inspect",
      );

      return parseMcpResult(result) as Record<string, unknown>;
    } catch (err) {
      console.warn("[memory] inspect failed:", err);
      if (err instanceof Error && err.message.includes("timed out")) {
        this.forceDisconnect();
      }
      return null;
    }
  }

  get isAvailable(): boolean {
    return this.available;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.transport = null;
    }
  }
}

export const memoryClient = new MemoryClient();
