import { describe, test, expect, mock, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, unlinkSync, existsSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

const TMP_VAULT = resolve(tmpdir(), `noah-self-knowledge-test-${process.pid}`);
const NOTE_PATH = resolve(TMP_VAULT, "Noah-Self-Knowledge.md");

// Reset modules between tests since the loader caches.
const testConfig = {
  vault: { enabled: true, path: TMP_VAULT },
};

mock.module("./config", () => ({ config: testConfig }));
mock.module("./logger", () => ({ log: () => {} }));

const { loadSelfKnowledge, resetSelfKnowledgeCache } = await import("./self-knowledge");

beforeEach(() => {
  resetSelfKnowledgeCache();
  testConfig.vault.enabled = true;
  testConfig.vault.path = TMP_VAULT;
  try {
    mkdirSync(TMP_VAULT, { recursive: true });
  } catch {}
  if (existsSync(NOTE_PATH)) {
    try { unlinkSync(NOTE_PATH); } catch {}
  }
});

describe("loadSelfKnowledge", () => {
  test("returns passthrough when vault is disabled", () => {
    testConfig.vault.enabled = false;
    const result = loadSelfKnowledge();
    expect(result.active).toBe(false);
    expect(result.source).toBe("passthrough");
    expect(result.text).toBe("");
  });

  test("returns passthrough when the note file is missing", () => {
    const result = loadSelfKnowledge();
    expect(result.active).toBe(false);
    expect(result.source).toBe("passthrough");
  });

  test("returns passthrough when the note is empty", () => {
    writeFileSync(NOTE_PATH, "   \n\n  ");
    const result = loadSelfKnowledge();
    expect(result.active).toBe(false);
  });

  test("loads the note when present and non-empty", () => {
    writeFileSync(
      NOTE_PATH,
      "# Noah self-knowledge\n\n- HIGH: I accept false premises.\n",
    );
    const result = loadSelfKnowledge();
    expect(result.active).toBe(true);
    expect(result.text).toContain("false premises");
    expect(result.tokenEstimate).toBeGreaterThan(0);
    expect(result.source).toBe(NOTE_PATH);
    expect(result.mtime).not.toBe("none");
    // cso M1: sha256 is computed and exposed so log analysis can detect
    // mid-session vault edits as a hash drift.
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses files exceeding the 32KB cap (cso M1)", () => {
    // 40KB > 32KB cap → load is refused, falls back to passthrough.
    writeFileSync(NOTE_PATH, "x".repeat(40 * 1024));
    const result = loadSelfKnowledge();
    expect(result.active).toBe(false);
    expect(result.source).toBe("passthrough");
  });

  test("caches the load — second call does not re-read disk", () => {
    writeFileSync(NOTE_PATH, "first version");
    const first = loadSelfKnowledge();
    // Overwrite the file; cache should keep the original.
    writeFileSync(NOTE_PATH, "second version");
    const second = loadSelfKnowledge();
    expect(first.text).toBe("first version");
    expect(second.text).toBe("first version");
  });

  test("resetSelfKnowledgeCache forces a re-read", () => {
    writeFileSync(NOTE_PATH, "before");
    expect(loadSelfKnowledge().text).toBe("before");
    writeFileSync(NOTE_PATH, "after");
    resetSelfKnowledgeCache();
    expect(loadSelfKnowledge().text).toBe("after");
  });
});

// Best-effort cleanup so we don't litter the temp dir.
try {
  rmSync(TMP_VAULT, { recursive: true, force: true });
} catch {}
