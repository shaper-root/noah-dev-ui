import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, utimesSync, existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { config } from "./config";
import {
  buildVaultIndexEntries,
  extractTitleAndTopics,
  searchVault,
} from "./vault";
import {
  loadVaultIndex,
  refreshVaultIndex,
  resetVaultIndexCache,
} from "./vault-index";

const FIXTURE = resolve(import.meta.dir, ".test-vault-index-fixture");
const originalVault = { ...config.vault };

// Helper: write a note and stamp its mtime so recency ordering is deterministic.
function note(relPath: string, content: string, mtime: Date): void {
  const abs = resolve(FIXTURE, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  utimesSync(abs, mtime, mtime);
}

beforeAll(() => {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });

  // Recency: alpha (newest) > beta > gamma (oldest).
  note(
    "projects/alpha.md",
    "# Alpha Project\nIntro text.\n## Architecture\nstuff\n## Roadmap\nmore\n## Risks\nx",
    new Date("2026-06-15T12:00:00Z"),
  );
  note(
    "reference/beta.md",
    "# Beta Notes\nSome reference.\n## Swish Integration\ndetails about the swish flow\n## Pricing\n$",
    new Date("2026-06-10T12:00:00Z"),
  );
  note(
    "daily/2026-06-07.md",
    "# Daily 2026-06-07\n## Meeting Notes\nNotes body.\n## Decisions\nDecided things.",
    new Date("2026-06-07T12:00:00Z"),
  );
  // No H1 → title falls back to filename.
  note(
    "reference/no-title.md",
    "Just body text, no headers here, but long enough to clear the 50-byte floor.",
    new Date("2026-06-08T12:00:00Z"),
  );
  // Frontmatter should be skipped when finding the H1.
  note(
    "projects/frontmatter.md",
    "---\ntitle: ignored-yaml\ntags: [a]\n---\n# Real Title\n## Topic One\nbody",
    new Date("2026-06-09T12:00:00Z"),
  );

  // Exclusions — none of these may appear in the index.
  note("_noah/sessions/log.md", "# Noah Session\n## machine generated", new Date("2026-06-14T12:00:00Z"));
  note("06-sensitive/secret.md", "# Secret\n## hidden", new Date("2026-06-14T12:00:00Z"));
  note("shannon-notes/codebook.md", "# Shannon\n## blocked", new Date("2026-06-14T12:00:00Z"));
  mkdirSync(resolve(FIXTURE, ".obsidian"), { recursive: true });
  writeFileSync(resolve(FIXTURE, ".obsidian", "app.md"), "# Obsidian config\n## settings");
  // Sub-50-byte placeholder — excluded from the index.
  note("projects/stub.md", "# tiny", new Date("2026-06-13T12:00:00Z"));

  config.vault.enabled = true;
  config.vault.path = FIXTURE;
  config.vault.exclude = [".obsidian", "06-sensitive", "_raw"];
  config.vault.maxFileBytes = 200_000;
  config.vault.maxResults = 8;
  config.vault.snippetChars = 240;
  resetVaultIndexCache();
});

afterAll(() => {
  rmSync(FIXTURE, { recursive: true, force: true });
  Object.assign(config.vault, originalVault);
  resetVaultIndexCache();
});

describe("extractTitleAndTopics", () => {
  test("pulls first H1 as title and H2s as topics", () => {
    const { title, topics } = extractTitleAndTopics(
      "# My Title\n## A\n## B\n## C\n## D",
      "fallback.md",
    );
    expect(title).toBe("My Title");
    expect(topics).toEqual(["A", "B", "C"]); // capped at 3
  });

  test("falls back to filename (no extension) when no H1", () => {
    const { title, topics } = extractTitleAndTopics("no headers", "Some-Note.md");
    expect(title).toBe("Some-Note");
    expect(topics).toEqual([]);
  });

  test("skips YAML frontmatter when locating the H1", () => {
    const { title } = extractTitleAndTopics(
      "---\ntitle: yaml\n---\n# Real\n## T",
      "x.md",
    );
    expect(title).toBe("Real");
  });
});

describe("buildVaultIndexEntries", () => {
  const paths = () => buildVaultIndexEntries().map((e) => e.path);

  test("indexes real notes with titles and topics", () => {
    const entries = buildVaultIndexEntries();
    const alpha = entries.find((e) => e.path === "projects/alpha.md");
    expect(alpha).toBeDefined();
    expect(alpha!.title).toBe("Alpha Project");
    expect(alpha!.topics).toEqual(["Architecture", "Roadmap", "Risks"]);
    expect(alpha!.dir).toBe("projects");
    expect(alpha!.bytes).toBeGreaterThan(0);
  });

  test("excludes _noah/, .obsidian, 06-sensitive, and shannon paths", () => {
    const p = paths();
    expect(p.some((x) => x.startsWith("_noah/"))).toBe(false);
    expect(p.some((x) => x.startsWith(".obsidian"))).toBe(false);
    expect(p.some((x) => x.startsWith("06-sensitive"))).toBe(false);
    expect(p.some((x) => x.toLowerCase().includes("shannon"))).toBe(false);
  });

  test("excludes sub-50-byte placeholder notes", () => {
    expect(paths()).not.toContain("projects/stub.md");
  });

  test("title falls back to filename when the note has no H1", () => {
    const e = buildVaultIndexEntries().find((x) => x.path === "reference/no-title.md");
    expect(e!.title).toBe("no-title");
  });
});

describe("loadVaultIndex", () => {
  test("is active with correct file/dir counts and a disk copy", () => {
    resetVaultIndexCache();
    const idx = loadVaultIndex();
    expect(idx.active).toBe(true);
    // alpha, beta, daily, no-title, frontmatter = 5 (stub excluded, exclusions excluded)
    expect(idx.fileCount).toBe(5);
    expect(idx.dirCount).toBe(3); // projects, reference, daily
    expect(existsSync(resolve(FIXTURE, "_noah", "vault-index.md"))).toBe(true);
    const disk = readFileSync(resolve(FIXTURE, "_noah", "vault-index.md"), "utf-8");
    expect(disk).toContain("## projects/");
    expect(disk).toContain("Alpha Project");
  });

  test("compact summary lists areas and most-recent notes, newest first", () => {
    resetVaultIndexCache();
    const { compactSummary } = loadVaultIndex();
    expect(compactSummary).toContain("5 notes across 3 directories");
    expect(compactSummary).toContain("projects/ (");
    // alpha (Jun 15) is newest → must appear before beta (Jun 10) in the recent list.
    const ai = compactSummary.indexOf("projects/alpha.md");
    const bi = compactSummary.indexOf("reference/beta.md");
    expect(ai).toBeGreaterThanOrEqual(0);
    expect(bi).toBeGreaterThan(ai);
  });

  test("caches: a second load returns the same generation timestamp", () => {
    resetVaultIndexCache();
    const a = loadVaultIndex();
    const b = loadVaultIndex();
    expect(b.generatedAtMs).toBe(a.generatedAtMs);
  });

  test("refresh forces a new generation", () => {
    const a = loadVaultIndex();
    const b = refreshVaultIndex();
    expect(b.generatedAtMs).toBeGreaterThanOrEqual(a.generatedAtMs);
    expect(b.active).toBe(true);
  });
});

describe("searchVault — index-aware ranking", () => {
  test("finds a term that lives in an H2 header but not the filename", () => {
    const hits = searchVault("Swish");
    const beta = hits.find((h) => h.path === "reference/beta.md");
    expect(beta).toBeDefined();
    expect(beta!.topics).toContain("Swish Integration");
  });

  test("surfaces title and topics on every hit", () => {
    const hits = searchVault("Alpha");
    expect(hits[0].title).toBe("Alpha Project");
    expect(Array.isArray(hits[0].topics)).toBe(true);
  });

  test("title match outranks a body-only mention", () => {
    // "Alpha" appears in alpha.md's title; ensure it's the top hit for that term.
    const hits = searchVault("Alpha");
    expect(hits[0].path).toBe("projects/alpha.md");
  });
});
