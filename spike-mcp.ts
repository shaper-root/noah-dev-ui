/**
 * Bun + MCP SDK compatibility spike.
 * Spawns memory-api MCP server via stdio, calls memory_recall, verifies response.
 * Run: bun run spike-mcp.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "path";
import { pathToFileURL } from "url";

// Bun.spawn on Windows (v1.3.11): cwd breaks executable resolution, paths with
// spaces cause ENOENT. Workaround: skip cwd, use 8.3 short paths, absolute file
// URLs for --import.
const MEMORY_API_DIR = resolve(import.meta.dir, "../../memory-api");
const NODE_BIN = Bun.which("node")?.replace(/Program Files/gi, "PROGRA~1")
  ?? (() => { throw new Error("node not found in PATH"); })();
const TSX_REGISTER = pathToFileURL(
  resolve(MEMORY_API_DIR, "node_modules/tsx/dist/loader.mjs"),
).href;

// MCP SDK v1.29.0 wire format: newline-delimited JSON (not LSP Content-Length).
// Bun.spawn stdin is a FileSink — write() returns a Promise that must be awaited.
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

async function main() {
  console.log("[spike] Starting Bun + MCP SDK compatibility test...");

  const serverFile = resolve(MEMORY_API_DIR, "src/mcp/server.ts");
  const sqlitePath = resolve(MEMORY_API_DIR, "data/sqlite/memory.db");

  const transport = new BunStdioTransport(
    NODE_BIN,
    ["--import", TSX_REGISTER, serverFile],
    {
      ...process.env as Record<string, string>,
      MEMORY_USER_ID: "spike-test-user",
      SQLITE_PATH: sqlitePath,
    },
  );

  const client = new Client({
    name: "spike-test",
    version: "0.0.1",
  });

  try {
    await client.connect(transport);
    console.log("[spike] Connected to MCP server");

    const tools = await client.listTools();
    console.log(`[spike] Tools available: ${tools.tools.map(t => t.name).join(", ")}`);

    const expected = ["memory_remember", "memory_recall", "memory_forget", "memory_inspect"];
    const missing = expected.filter(e => !tools.tools.some(t => t.name === e));
    if (missing.length > 0) {
      throw new Error(`Missing expected tools: ${missing.join(", ")}`);
    }

    const result = await client.callTool({
      name: "memory_recall",
      arguments: { query: "spike test", topK: 1 },
    });

    console.log("[spike] memory_recall response:", JSON.stringify(result, null, 2));

    if (result.isError) {
      throw new Error(`memory_recall returned error: ${JSON.stringify(result.content)}`);
    }

    console.log("[spike] PASS — Bun + MCP SDK + custom stdio transport works correctly");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("[spike] FAIL:", err);
  process.exit(1);
});
