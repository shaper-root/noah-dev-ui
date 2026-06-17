import { describe, test, expect, beforeEach, afterAll, beforeAll, mock } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

// Build an isolated test environment: a fresh vault dir on disk + a mocked
// config so vault-bridge points at our fixture and not the real OneDrive
// vault. Mock memory-client so import tests don't actually go through MCP.

const TMP_VAULT = resolve(tmpdir(), `noah-vault-bridge-test-${process.pid}`);

const testConfig = {
  provider: "cloud" as "local" | "cloud",
  vault: {
    enabled: true,
    path: TMP_VAULT,
    exclude: [".obsidian", "06-sensitive"],
    maxFileBytes: 200_000,
    maxResults: 8,
    snippetChars: 240,
    trust: 0.9,
  },
  vaultBridge: { enabled: true, deviceId: "mac" },
  memory: {
    userId: "noah",
    sqlitePath: "", // disable real DB reads in these tests
    memoryApiDir: "",
  },
  ollama: { model: "test" },
  cloud: { model: "test" },
};

// Spy-able memory client so we can verify import calls + control recall results.
const mockRecall = mock();
const mockRemember = mock();

mock.module("./config", () => ({ config: testConfig }));
mock.module("./logger", () => ({ log: () => {} }));
mock.module("./memory-client", () => ({
  memoryClient: {
    recall: mockRecall,
    remember: mockRemember,
    get isAvailable() { return true; },
  },
}));
// db.ts opens a real SQLite at module load; mock it out — vault-bridge's
// summary/observation paths call DB.* which we stub here.
mock.module("./db", () => ({
  DB: {
    listConversations: () => [],
    getConversation: () => null,
    getMessages: () => [],
  },
}));

// Import AFTER mocks are registered so vault-bridge sees the mocked deps.
const {
  exportMemoryIncremental,
  importMemoriesFromOtherDevices,
  parseExportFile,
  reconcileMemoryExports,
  loadManifest,
  resetManifestCache,
  appendObservations,
  readRecentSessionSummaries,
  deviceId,
} = await import("./vault-bridge");

beforeAll(() => {
  rmSync(TMP_VAULT, { recursive: true, force: true });
  mkdirSync(TMP_VAULT, { recursive: true });
});

afterAll(() => {
  rmSync(TMP_VAULT, { recursive: true, force: true });
});

beforeEach(() => {
  // Wipe the _noah/ tree between tests so each is hermetic.
  rmSync(resolve(TMP_VAULT, "_noah"), { recursive: true, force: true });
  mockRecall.mockReset();
  mockRemember.mockReset();
  resetManifestCache();
  mockRecall.mockResolvedValue({ count: 0, signals: {}, totalMs: 0, memories: [] });
  mockRemember.mockResolvedValue({ stored: true, id: "imported-id", confidence: 0.85 });
});

describe("device + paths", () => {
  test("deviceId returns the config value", () => {
    expect(deviceId()).toBe("mac");
  });
});

describe("memory export (incremental)", () => {
  test("first export creates the day's file with frontmatter + entry", () => {
    exportMemoryIncremental({
      id: "abc-123",
      content: "Root prefers dark roast",
      type: "preference",
      source: "conversation",
      source_ref: "model:cloud:test",
      confidence: 0.85,
      created_at: "2026-06-16T19:45:00Z",
    });
    const today = new Date().toISOString().slice(0, 10);
    const file = resolve(TMP_VAULT, `_noah/memories/${today}_mac.md`);
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf-8");
    expect(text).toContain("device: mac");
    expect(text).toContain("memory_count: 1");
    expect(text).toContain("### mem_abc-123");
    expect(text).toContain("Root prefers dark roast");
  });

  test("second export to the same day appends without duplicating", () => {
    exportMemoryIncremental({
      id: "abc-1", content: "Fact one", type: "fact", source: "conversation",
      source_ref: null, confidence: 0.85, created_at: "2026-06-16T10:00:00Z",
    });
    exportMemoryIncremental({
      id: "abc-2", content: "Fact two", type: "fact", source: "conversation",
      source_ref: null, confidence: 0.85, created_at: "2026-06-16T11:00:00Z",
    });
    const today = new Date().toISOString().slice(0, 10);
    const file = resolve(TMP_VAULT, `_noah/memories/${today}_mac.md`);
    const text = readFileSync(file, "utf-8");
    expect(text).toContain("memory_count: 2");
    expect(text).toContain("### mem_abc-1");
    expect(text).toContain("### mem_abc-2");
  });

  test("re-exporting the same ID is idempotent (no duplicate entry)", () => {
    const row = {
      id: "dup", content: "test", type: "fact", source: "conversation",
      source_ref: null, confidence: 0.85, created_at: "2026-06-16T10:00:00Z",
    };
    exportMemoryIncremental(row);
    exportMemoryIncremental(row);
    const today = new Date().toISOString().slice(0, 10);
    const text = readFileSync(
      resolve(TMP_VAULT, `_noah/memories/${today}_mac.md`),
      "utf-8",
    );
    // memory_count should be 1, not 2 — idempotent on ID.
    expect(text.match(/### mem_dup/g)?.length).toBe(1);
  });

  test("no-op when vault bridge is disabled", () => {
    testConfig.vaultBridge.enabled = false;
    exportMemoryIncremental({
      id: "z", content: "test", type: "fact", source: "conversation",
      source_ref: null, confidence: 0.85, created_at: "2026-06-16T10:00:00Z",
    });
    const today = new Date().toISOString().slice(0, 10);
    expect(existsSync(resolve(TMP_VAULT, `_noah/memories/${today}_mac.md`))).toBe(false);
    testConfig.vaultBridge.enabled = true;
  });
});

describe("memory export parser", () => {
  test("round-trips a written file back into the same memories", () => {
    exportMemoryIncremental({
      id: "rt-1",
      content: "Multi line\ncontent test",
      type: "fact",
      source: "conversation",
      source_ref: "model:cloud:x",
      confidence: 0.9,
      created_at: "2026-06-16T12:00:00Z",
    });
    const today = new Date().toISOString().slice(0, 10);
    const text = readFileSync(
      resolve(TMP_VAULT, `_noah/memories/${today}_mac.md`),
      "utf-8",
    );
    const parsed = parseExportFile(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.device).toBe("mac");
    expect(parsed!.memories).toHaveLength(1);
    expect(parsed!.memories[0].id).toBe("rt-1");
    expect(parsed!.memories[0].content).toBe("Multi line\ncontent test");
    expect(parsed!.memories[0].confidence).toBe(0.9);
  });

  test("returns null on missing frontmatter", () => {
    expect(parseExportFile("just some markdown")).toBeNull();
  });
});

describe("memory import (cross-device)", () => {
  test("imports memories from another device's export file", async () => {
    // Manually write an "omen" export file as if synced from the other device.
    mkdirSync(resolve(TMP_VAULT, "_noah/memories"), { recursive: true });
    const omenFile = `---
device: omen
session_date: 2026-06-15T00:00:00Z
exported_at: 2026-06-15T22:00:00Z
memory_count: 1
---

## Memories exported from omen session (2026-06-15)

### mem_omen-1
- **content:** Root's office printer is on the 2nd floor
- **type:** fact
- **source:** conversation
- **trust:** 0.85
- **source_ref:** model:cloud:test
- **created_at:** 2026-06-15T20:00:00Z
`;
    writeFileSync(resolve(TMP_VAULT, "_noah/memories/2026-06-15_omen.md"), omenFile);

    const summary = await importMemoriesFromOtherDevices();
    expect(summary.filesScanned).toBe(1);
    expect(summary.filesImported).toBe(1);
    expect(summary.memoriesAttempted).toBe(1);
    expect(summary.memoriesStored).toBe(1);
    expect(mockRemember).toHaveBeenCalledTimes(1);
    // The import must request explicit:true to bypass the worthiness gate
    // for short cross-device memories.
    const callArgs = mockRemember.mock.calls[0]?.[1] as { explicit?: boolean };
    expect(callArgs.explicit).toBe(true);
  });

  test("skips files from this device", async () => {
    mkdirSync(resolve(TMP_VAULT, "_noah/memories"), { recursive: true });
    writeFileSync(
      resolve(TMP_VAULT, "_noah/memories/2026-06-15_mac.md"),
      `---
device: mac
session_date: 2026-06-15T00:00:00Z
exported_at: 2026-06-15T22:00:00Z
memory_count: 1
---

### mem_x
- **content:** local memory
- **type:** fact
- **source:** conversation
- **trust:** 0.85
- **source_ref:** (none)
- **created_at:** 2026-06-15T20:00:00Z
`,
    );
    const summary = await importMemoriesFromOtherDevices();
    expect(summary.filesScanned).toBe(1);
    expect(summary.memoriesAttempted).toBe(0);
    expect(mockRemember).not.toHaveBeenCalled();
  });

  test("dedupe: exact content match via recall → skip without write", async () => {
    mockRecall.mockResolvedValue({
      count: 1,
      signals: {},
      totalMs: 0,
      memories: [
        {
          id: "existing-1",
          content: "exact same content",
          type: "fact",
          category: "stable",
          scope: "x",
          source: "conversation",
          entities: [],
          keywords: [],
          confidence: 0.85,
          created_at: "2026-06-10",
          score: 1.0,
        },
      ],
    });
    mkdirSync(resolve(TMP_VAULT, "_noah/memories"), { recursive: true });
    writeFileSync(
      resolve(TMP_VAULT, "_noah/memories/2026-06-15_omen.md"),
      `---
device: omen
session_date: 2026-06-15T00:00:00Z
exported_at: 2026-06-15T22:00:00Z
memory_count: 1
---

### mem_omen-dup
- **content:** exact same content
- **type:** fact
- **source:** conversation
- **trust:** 0.85
- **source_ref:** (none)
- **created_at:** 2026-06-15T20:00:00Z
`,
    );
    const summary = await importMemoriesFromOtherDevices();
    expect(summary.memoriesSkippedDuplicate).toBe(1);
    expect(summary.memoriesStored).toBe(0);
    expect(mockRemember).not.toHaveBeenCalled();
  });

  test("manifest prevents re-import on second run", async () => {
    mkdirSync(resolve(TMP_VAULT, "_noah/memories"), { recursive: true });
    writeFileSync(
      resolve(TMP_VAULT, "_noah/memories/2026-06-14_omen.md"),
      `---
device: omen
session_date: 2026-06-14T00:00:00Z
exported_at: 2026-06-14T22:00:00Z
memory_count: 1
---

### mem_persist-1
- **content:** persistent fact across runs
- **type:** fact
- **source:** conversation
- **trust:** 0.85
- **source_ref:** (none)
- **created_at:** 2026-06-14T20:00:00Z
`,
    );
    await importMemoriesFromOtherDevices();
    expect(mockRemember).toHaveBeenCalledTimes(1);

    mockRemember.mockClear();
    resetManifestCache();
    // Second run: same file → manifest skips it.
    const summary2 = await importMemoriesFromOtherDevices();
    expect(summary2.memoriesAttempted).toBe(1);
    expect(summary2.memoriesSkippedDuplicate).toBe(1);
    expect(mockRemember).not.toHaveBeenCalled();
  });
});

describe("observations (Phase 4)", () => {
  test("first observation creates daily file with frontmatter", () => {
    appendObservations({
      conversationId: "conv-abc-12345678",
      sessionDate: "2026-06-16",
      sessionTime: "15:00",
      device: "mac",
      storeAttempted: 3,
      storeSucceeded: 2,
      storeFailed: 1,
      recallQueriesCount: 5,
      recallVagueCount: 1,
      recallEmptyCount: 0,
      sessionStartBriefFired: true,
      selfKnowledgeActive: true,
      notes: ["Pattern: explicit store on books test failed late-session"],
    });
    const file = resolve(TMP_VAULT, "_noah/observations/2026-06-16.md");
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf-8");
    expect(text).toContain("date: 2026-06-16");
    expect(text).toContain("3 attempted, 2 succeeded, 1 failed");
    expect(text).toContain("Session prep fired on first message: YES");
    expect(text).toContain("explicit store on books test failed late-session");
  });

  test("second observation appends to the same day's file", () => {
    appendObservations({
      conversationId: "conv-1-12345678",
      sessionDate: "2026-06-16", sessionTime: "10:00", device: "mac",
      storeAttempted: 1, storeSucceeded: 1, storeFailed: 0,
      recallQueriesCount: 1, recallVagueCount: 0, recallEmptyCount: 0,
      sessionStartBriefFired: false, selfKnowledgeActive: true, notes: [],
    });
    appendObservations({
      conversationId: "conv-2-87654321",
      sessionDate: "2026-06-16", sessionTime: "16:00", device: "mac",
      storeAttempted: 2, storeSucceeded: 2, storeFailed: 0,
      recallQueriesCount: 3, recallVagueCount: 0, recallEmptyCount: 1,
      sessionStartBriefFired: true, selfKnowledgeActive: true, notes: [],
    });
    const text = readFileSync(
      resolve(TMP_VAULT, "_noah/observations/2026-06-16.md"),
      "utf-8",
    );
    expect(text).toMatch(/Session conv-1-1/);
    expect(text).toMatch(/Session conv-2-8/);
    // Frontmatter exists exactly once at the top.
    expect((text.match(/^---$/gm) ?? []).length).toBe(2); // open + close fence
  });
});

describe("session summaries readback", () => {
  test("readRecentSessionSummaries returns newest first up to maxFiles", () => {
    mkdirSync(resolve(TMP_VAULT, "_noah/sessions"), { recursive: true });
    writeFileSync(resolve(TMP_VAULT, "_noah/sessions/2026-06-14_mac_1.md"), "old");
    writeFileSync(resolve(TMP_VAULT, "_noah/sessions/2026-06-15_mac_1.md"), "newer");
    writeFileSync(resolve(TMP_VAULT, "_noah/sessions/2026-06-16_mac_1.md"), "newest");
    const recent = readRecentSessionSummaries(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].text).toBe("newest");
    expect(recent[1].text).toBe("newer");
  });

  test("returns empty when no sessions directory exists", () => {
    expect(readRecentSessionSummaries()).toEqual([]);
  });
});

describe("manifest", () => {
  test("loadManifest returns empty defaults when file missing", () => {
    const m = loadManifest();
    expect(m.imported).toEqual({});
    expect(m.lastExportedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  test("loadManifest survives corrupt JSON", () => {
    mkdirSync(resolve(TMP_VAULT, "_noah"), { recursive: true });
    writeFileSync(resolve(TMP_VAULT, "_noah/_manifest.json"), "{not: valid");
    resetManifestCache();
    const m = loadManifest();
    expect(m.imported).toEqual({});
  });
});

describe("reconciliation guardrails", () => {
  test("reconcileMemoryExports returns zeros when memory.db is missing", () => {
    testConfig.memory.sqlitePath = resolve(TMP_VAULT, "nonexistent.db");
    const result = reconcileMemoryExports();
    expect(result.exported).toBe(0);
  });
});
