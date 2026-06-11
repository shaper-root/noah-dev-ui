import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";

export interface RecallFixture {
  id: string;
  description: string;
  seedMemories: Array<{
    content: string;
    type: string;
    category?: string;
    entities?: string[];
    keywords?: string[];
  }>;
  query: string;
  expectedContent: string;
  k: number;
}

export interface FixtureResult {
  fixture_id: string;
  pass: boolean;
  rank: number | null;
  total_results: number;
  latency_ms: number;
}

export interface HarnessReport {
  total: number;
  passed: number;
  failed: number;
  results: FixtureResult[];
  timestamp: string;
}

export const FIXTURES: RecallFixture[] = [
  {
    id: "fact-tea",
    description: "Exact factual recall — tea preference",
    seedMemories: [
      { content: "Root likes Earl Grey tea with a splash of oat milk", type: "preference", entities: ["Root"], keywords: ["tea", "Earl Grey", "oat milk"] },
      { content: "The kitchen light needs a new bulb", type: "context", keywords: ["kitchen", "light"] },
    ],
    query: "What tea does Root like?",
    expectedContent: "Earl Grey",
    k: 5,
  },
  {
    id: "fact-job",
    description: "Exact factual recall — occupation",
    seedMemories: [
      { content: "Root works as a software engineer, primarily on AI and local-first systems", type: "fact", entities: ["Root"], keywords: ["software engineer", "AI"] },
    ],
    query: "What does Root do for work?",
    expectedContent: "software engineer",
    k: 5,
  },
  {
    id: "pref-music",
    description: "Preference recall — music taste",
    seedMemories: [
      { content: "Root enjoys jazz, especially Miles Davis and Coltrane", type: "preference", entities: ["Root", "Miles Davis", "Coltrane"], keywords: ["jazz", "music"] },
    ],
    query: "What music does Root enjoy?",
    expectedContent: "jazz",
    k: 5,
  },
  {
    id: "pref-coffee",
    description: "Preference recall — coffee",
    seedMemories: [
      { content: "Root prefers black coffee, no sugar, usually from the French press", type: "preference", entities: ["Root"], keywords: ["coffee", "black", "French press"] },
    ],
    query: "How does Root take their coffee?",
    expectedContent: "black coffee",
    k: 5,
  },
  {
    id: "pref-lights",
    description: "Preference recall — home automation",
    seedMemories: [
      { content: "Root prefers lights dimmed to 30% after 9pm in the living room", type: "preference", entities: ["Root"], keywords: ["lights", "dim", "living room", "9pm"] },
    ],
    query: "What are the lighting preferences at night?",
    expectedContent: "lights dimmed",
    k: 5,
  },
  {
    id: "entity-luna",
    description: "Entity-based recall — pet",
    seedMemories: [
      { content: "Luna is the family cat, a grey tabby who is 4 years old", type: "fact", entities: ["Luna"], keywords: ["cat", "tabby", "pet"] },
      { content: "Luna prefers the window seat in the afternoon", type: "fact", entities: ["Luna"], keywords: ["window", "afternoon"] },
    ],
    query: "Tell me about Luna",
    expectedContent: "Luna",
    k: 5,
  },
  {
    id: "entity-alex",
    description: "Entity-based recall — relationship",
    seedMemories: [
      { content: "Alex is Root's partner. They met at a conference in 2019", type: "relationship", entities: ["Alex", "Root"], keywords: ["partner"] },
    ],
    query: "Who is Alex?",
    expectedContent: "partner",
    k: 5,
  },
  {
    id: "multi-morning",
    description: "Multi-signal recall — routine",
    seedMemories: [
      { content: "Root wakes up at 6am, makes coffee, then reads for 30 minutes before work", type: "habit", entities: ["Root"], keywords: ["morning", "routine", "6am", "coffee", "reading"] },
    ],
    query: "What's Root's morning routine?",
    expectedContent: "6am",
    k: 5,
  },
  {
    id: "multi-code",
    description: "Multi-signal recall — technical skills",
    seedMemories: [
      { content: "Root primarily uses TypeScript and Python, with some Rust for performance-critical code", type: "skill", entities: ["Root"], keywords: ["TypeScript", "Python", "Rust", "programming"] },
    ],
    query: "What programming languages does Root use?",
    expectedContent: "TypeScript",
    k: 5,
  },
  {
    id: "goal-fitness",
    description: "Goal recall — fitness target",
    seedMemories: [
      { content: "Root wants to run a half marathon by October 2026", type: "goal", entities: ["Root"], keywords: ["half marathon", "running", "fitness", "October 2026"] },
    ],
    query: "What are Root's fitness goals?",
    expectedContent: "half marathon",
    k: 5,
  },
  {
    id: "neg-unrelated",
    description: "Negative — query with no matching memory",
    seedMemories: [],
    query: "What is the average rainfall in the Amazon basin?",
    expectedContent: "",
    k: 5,
  },
  {
    id: "neg-gibberish",
    description: "Negative — nonsense query",
    seedMemories: [],
    query: "xyzzy plugh flob wumpus",
    expectedContent: "",
    k: 5,
  },
];

export function checkRecall(
  fixture: RecallFixture,
  recalledMemories: Array<{ content: string }>,
  latencyMs: number,
): FixtureResult {
  const topK = recalledMemories.slice(0, fixture.k);

  if (fixture.expectedContent === "") {
    return {
      fixture_id: fixture.id,
      pass: topK.length === 0,
      rank: null,
      total_results: recalledMemories.length,
      latency_ms: latencyMs,
    };
  }

  let rank: number | null = null;
  for (let i = 0; i < topK.length; i++) {
    if (topK[i].content.includes(fixture.expectedContent)) {
      rank = i + 1;
      break;
    }
  }

  return {
    fixture_id: fixture.id,
    pass: rank !== null,
    rank,
    total_results: recalledMemories.length,
    latency_ms: latencyMs,
  };
}

export function validateFixtures(fixtures: RecallFixture[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const f of fixtures) {
    if (!f.id) errors.push("Fixture missing id");
    if (ids.has(f.id)) errors.push(`Duplicate fixture id: ${f.id}`);
    ids.add(f.id);
    if (!f.description) errors.push(`${f.id}: missing description`);
    if (!f.query) errors.push(`${f.id}: missing query`);
    if (f.k < 1) errors.push(`${f.id}: k must be >= 1`);
    if (f.expectedContent !== "" && f.seedMemories.length === 0) {
      errors.push(`${f.id}: positive fixture needs seed memories`);
    }
  }

  return errors;
}

export function formatReport(report: HarnessReport): string {
  const lines: string[] = [];
  lines.push("recall@k Evaluation Report");
  lines.push("=".repeat(60));
  lines.push(`Date: ${report.timestamp}`);
  lines.push(
    `Fixtures: ${report.total} | Passed: ${report.passed} | Failed: ${report.failed}`,
  );
  lines.push("");

  const idWidth = Math.max(
    4,
    ...report.results.map((r) => r.fixture_id.length),
  );
  const header = `${"ID".padEnd(idWidth)} | Pass | Rank | Results | Latency`;
  lines.push(header);
  lines.push("-".repeat(header.length));

  for (const r of report.results) {
    const pass = r.pass ? " yes" : "  NO";
    const rank = r.rank !== null ? String(r.rank).padStart(4) : "   -";
    const results = String(r.total_results).padStart(7);
    const latency = `${r.latency_ms}ms`.padStart(7);
    lines.push(
      `${r.fixture_id.padEnd(idWidth)} | ${pass} | ${rank} | ${results} | ${latency}`,
    );
  }

  lines.push("");
  const passRate = report.total > 0 ? (report.passed / report.total) * 100 : 0;
  lines.push(`Pass rate: ${passRate.toFixed(1)}%`);

  return lines.join("\n");
}

class EvalTransport implements Transport {
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
          const text = decoder.decode(value);
          if (text.includes("ERROR") || text.includes("error")) {
            process.stderr.write(`[eval-mcp] ${text}`);
          }
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
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) return;
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
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

function parseMcpResult(result: {
  content: unknown;
  isError?: boolean;
}): unknown {
  const text = Array.isArray(result.content)
    ? (result.content as Array<{ text?: string }>)
        .map((c) => c.text || "")
        .join("")
    : String(result.content);
  return JSON.parse(text);
}

async function runHarness(
  fixtures: RecallFixture[] = FIXTURES,
): Promise<HarnessReport> {
  const errors = validateFixtures(fixtures);
  if (errors.length > 0) {
    throw new Error(`Fixture validation failed:\n${errors.join("\n")}`);
  }

  const tmpDir = mkdtempSync(resolve(tmpdir(), "noah-eval-"));
  const sqlitePath = resolve(tmpDir, "eval.db");

  const memoryApiDir = resolve(import.meta.dir, "../../../memory-api");
  const nodeBin =
    Bun.which("node")?.replace(/Program Files/gi, "PROGRA~1") ??
    (() => {
      throw new Error("node not found in PATH");
    })();
  const tsxRegister = pathToFileURL(
    resolve(memoryApiDir, "node_modules/tsx/dist/loader.mjs"),
  ).href;
  const serverFile = resolve(memoryApiDir, "src/mcp/server.ts");

  const transport = new EvalTransport(
    nodeBin,
    ["--import", tsxRegister, serverFile],
    {
      ...(process.env as Record<string, string>),
      SQLITE_PATH: sqlitePath,
      MEMORY_USER_ID: "eval-harness",
    },
  );

  const client = new Client({ name: "recall-eval", version: "0.1.0" });

  try {
    await client.connect(transport);
    console.log(`[eval] Connected. DB: ${sqlitePath}`);

    const allSeeds = fixtures.flatMap((f) => f.seedMemories);
    let seeded = 0;
    for (const seed of allSeeds) {
      await client.callTool({
        name: "memory_remember",
        arguments: {
          content: seed.content,
          type: seed.type,
          ...(seed.category && { category: seed.category }),
          ...(seed.entities && { entities: seed.entities }),
          ...(seed.keywords && { keywords: seed.keywords }),
        },
      });
      seeded++;
    }
    console.log(`[eval] Seeded ${seeded} memories`);

    const results: FixtureResult[] = [];
    for (const fixture of fixtures) {
      const start = Date.now();
      const result = await client.callTool({
        name: "memory_recall",
        arguments: { query: fixture.query, topK: fixture.k },
      });
      const latencyMs = Date.now() - start;

      const parsed = parseMcpResult(result) as {
        memories: Array<{ content: string }>;
      };
      const fixtureResult = checkRecall(
        fixture,
        parsed.memories || [],
        latencyMs,
      );
      results.push(fixtureResult);

      const status = fixtureResult.pass ? "PASS" : "FAIL";
      console.log(
        `[eval] ${status} ${fixture.id} (rank: ${fixtureResult.rank ?? "-"})`,
      );
    }

    const report: HarnessReport = {
      total: results.length,
      passed: results.filter((r) => r.pass).length,
      failed: results.filter((r) => !r.pass).length,
      results,
      timestamp: new Date().toISOString(),
    };

    return report;
  } finally {
    await client.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

if (import.meta.main) {
  try {
    const report = await runHarness();
    console.log("\n" + formatReport(report));

    const jsonPath = resolve(import.meta.dir, "recall-report.json");
    await Bun.write(jsonPath, JSON.stringify(report, null, 2));
    console.log(`\nJSON report: ${jsonPath}`);

    process.exit(report.failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("[eval] Fatal:", err);
    process.exit(2);
  }
}
