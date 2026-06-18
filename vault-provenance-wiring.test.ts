import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { resolve } from "path";
import { config } from "./config";

// Drive the REAL read path (tool-router dispatchTool) end-to-end and assert the
// model-facing output carries the CLASSIFIER's per-file trust — closing the gap
// the smoke test exposed: the classifier scored Noah-Self-Knowledge.md at 0.5,
// but the model reported a blanket "vault = 90%". This proves the tool-router
// actually calls vaultProvenance() per file and renders the computed trust.
//
// RUN IN ISOLATION: `bun test vault-provenance-wiring.test.ts`. Importing
// tool-router pulls in memory-client (process-global mock surface), so per the
// repo's per-file convention, run this file alone.
const { dispatchTool } = await import("./tool-router");

const FIXTURE = resolve(import.meta.dir, ".test-vault-wiring-fixture");
const saved = { ...config.vault };

async function vaultRead(path: string): Promise<string> {
  return dispatchTool({
    id: "t",
    function: { name: "vault_read", arguments: { path } },
  });
}

describe("read-path wiring (dispatchTool → classifier → model context)", () => {
  beforeAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(resolve(FIXTURE, "short story"), { recursive: true });
    writeFileSync(
      resolve(FIXTURE, "Noah-Self-Knowledge.md"),
      "Noah's own self-written behavioral notes.",
    );
    writeFileSync(
      resolve(FIXTURE, "short story", "ch1.md"),
      "Once upon a time, Root wrote this.",
    );
    config.vault.enabled = true;
    config.vault.path = FIXTURE;
    config.vault.exclude = [".obsidian", "06-sensitive", "_raw"];
    config.vault.maxFileBytes = 200_000;
    config.vault.maxResults = 8;
    config.vault.snippetChars = 240;
  });

  afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
    Object.assign(config.vault, saved);
  });

  test("HEADLINE: vault_read of Noah-Self-Knowledge.md surfaces 0.5 (not 90%)", async () => {
    const out = await vaultRead("Noah-Self-Knowledge.md");
    expect(out).toContain("trust: 50%");
    expect(out).toContain("source: vault_unknown");
    expect(out).toContain("authorship: UNVERIFIED");
    expect(out).not.toContain("trust: 90%");
  });

  test("vault_read of an allowlisted location surfaces 0.9 / vault_authored", async () => {
    const out = await vaultRead("short story/ch1.md");
    expect(out).toContain("trust: 90%");
    expect(out).toContain("source: vault_authored");
    expect(out).not.toContain("authorship: UNVERIFIED");
  });

  test("vault overview no longer carries a blanket vault trust", async () => {
    const out = await dispatchTool({
      id: "t",
      function: { name: "vault_search", arguments: { query: "" } },
    });
    const parsed = JSON.parse(out) as { source?: string; trust?: number };
    expect(parsed.source).toBe("obsidian_vault");
    // The static "vault = 90%" blanket is gone — trust is per-file at read time.
    expect(parsed.trust).toBeUndefined();
  });
});
