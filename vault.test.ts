import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { config } from "./config";
import {
  listVaultFiles,
  searchVault,
  readVaultFile,
  vaultStats,
  vaultAvailable,
  writeNote,
  appendToNote,
} from "./vault";

const FIXTURE = resolve(import.meta.dir, ".test-vault-fixture");

const originalVault = { ...config.vault };

beforeAll(() => {
  // Build a small fixture vault: two readable notes, one excluded dir, one
  // shannon-named file (must be hard-blocked), one non-text file (ignored).
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(resolve(FIXTURE, "projects"), { recursive: true });
  mkdirSync(resolve(FIXTURE, "06-sensitive"), { recursive: true });
  mkdirSync(resolve(FIXTURE, "shannon-notes"), { recursive: true });

  writeFileSync(
    resolve(FIXTURE, "projects", "noah.md"),
    "# Noah\nNoah is a memory-equipped agent. Root prefers Python for scripting.",
  );
  writeFileSync(
    resolve(FIXTURE, "intel.md"),
    "Market intel: the widget sector is growing.",
  );
  writeFileSync(
    resolve(FIXTURE, "06-sensitive", "secret.md"),
    "TOP SECRET sensitive content",
  );
  writeFileSync(
    resolve(FIXTURE, "shannon-notes", "codebook.md"),
    "shannon codebook material",
  );
  writeFileSync(resolve(FIXTURE, "image.png"), "not text");

  config.vault.enabled = true;
  config.vault.path = FIXTURE;
  config.vault.exclude = [".obsidian", "06-sensitive"];
  config.vault.maxFileBytes = 200_000;
  config.vault.maxResults = 8;
  config.vault.snippetChars = 240;
});

afterAll(() => {
  rmSync(FIXTURE, { recursive: true, force: true });
  Object.assign(config.vault, originalVault);
});

describe("vault listing", () => {
  test("vaultAvailable true for existing fixture", () => {
    expect(vaultAvailable()).toBe(true);
  });

  test("lists only accessible text files (excludes sensitive, shannon, non-text)", () => {
    const files = listVaultFiles().map((f) => f.path);
    expect(files).toContain("projects/noah.md");
    expect(files).toContain("intel.md");
    expect(files).not.toContain("06-sensitive/secret.md");
    expect(files).not.toContain("shannon-notes/codebook.md");
    expect(files.some((f) => f.endsWith(".png"))).toBe(false);
  });

  test("stats counts accessible files", () => {
    const stats = vaultStats();
    expect(stats.fileCount).toBe(2);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });
});

describe("vault search", () => {
  test("finds content by keyword with a snippet", () => {
    const hits = searchVault("Python");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toBe("projects/noah.md");
    expect(hits[0].snippet.toLowerCase()).toContain("python");
  });

  test("does not surface excluded or shannon content", () => {
    expect(searchVault("SECRET").length).toBe(0);
    expect(searchVault("codebook").length).toBe(0);
  });

  test("empty query returns no hits (use listing mode instead)", () => {
    expect(searchVault("").length).toBe(0);
  });
});

describe("vault read", () => {
  test("reads an accessible file", () => {
    const r = readVaultFile("projects/noah.md");
    expect(r.ok).toBe(true);
    expect(r.content).toContain("memory-equipped");
    expect(r.path).toBe("projects/noah.md");
  });

  test("blocks path traversal", () => {
    expect(readVaultFile("../../config.ts").ok).toBe(false);
    expect(readVaultFile("../package.json").ok).toBe(false);
  });

  test("blocks absolute paths", () => {
    expect(readVaultFile("C:\\Windows\\system.ini").ok).toBe(false);
    expect(readVaultFile("/etc/passwd").ok).toBe(false);
  });

  test("blocks excluded subtree", () => {
    expect(readVaultFile("06-sensitive/secret.md").ok).toBe(false);
  });

  test("hard-blocks shannon paths regardless of exclude list", () => {
    expect(readVaultFile("shannon-notes/codebook.md").ok).toBe(false);
  });

  test("06-sensitive stays blocked even if removed from the exclude list", () => {
    const saved = config.vault.exclude;
    config.vault.exclude = []; // operator wipes the configured list entirely
    expect(readVaultFile("06-sensitive/secret.md").ok).toBe(false);
    expect(
      listVaultFiles().some((f) => f.path.startsWith("06-sensitive")),
    ).toBe(false);
    config.vault.exclude = saved;
  });

  test("blocks symlink escape (realpath jail)", () => {
    // A symlink inside the vault pointing OUTSIDE must not be readable.
    // Symlink creation needs privileges on Windows — skip cleanly if denied.
    const secretOutside = resolve(import.meta.dir, ".test-vault-secret.md");
    writeFileSync(secretOutside, "ESCAPED SECRET");
    const linkPath = resolve(FIXTURE, "escape.md");
    let created = false;
    try {
      symlinkSync(secretOutside, linkPath, "file");
      created = true;
    } catch {
      // EPERM/EACCES on Windows without developer mode — skip.
    }
    if (created) {
      const r = readVaultFile("escape.md");
      expect(r.ok).toBe(false);
    }
    rmSync(secretOutside, { force: true });
  });

  test("missing file returns a clean error, not a throw", () => {
    const r = readVaultFile("nope.md");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  test("truncates content over the byte cap", () => {
    config.vault.maxFileBytes = 10;
    const r = readVaultFile("intel.md");
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.content!.length).toBeLessThanOrEqual(10);
    config.vault.maxFileBytes = 200_000;
  });
});

describe("vault writes (P3 vault-bridge)", () => {
  test("writeNote creates a file under _noah/ with the supplied content", () => {
    const r = writeNote("_noah/memories/test.md", "hello\n");
    expect(r.ok).toBe(true);
    expect(r.path).toBe("_noah/memories/test.md");
    expect(r.bytes).toBe(6);
    expect(existsSync(resolve(FIXTURE, "_noah/memories/test.md"))).toBe(true);
    expect(readFileSync(resolve(FIXTURE, "_noah/memories/test.md"), "utf-8")).toBe(
      "hello\n",
    );
  });

  test("writeNote refuses to clobber by default", () => {
    writeNote("_noah/dup.md", "first", { overwrite: false });
    const r = writeNote("_noah/dup.md", "second", { overwrite: false });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("exists");
    expect(readFileSync(resolve(FIXTURE, "_noah/dup.md"), "utf-8")).toBe("first");
  });

  test("writeNote with overwrite:true replaces existing content", () => {
    writeNote("_noah/over.md", "v1");
    const r = writeNote("_noah/over.md", "v2", { overwrite: true });
    expect(r.ok).toBe(true);
    expect(readFileSync(resolve(FIXTURE, "_noah/over.md"), "utf-8")).toBe("v2");
  });

  test("writeNote DENIES any path outside _noah/", () => {
    const cases = [
      "evil.md",
      "projects/evil.md",
      "../escape.md",
      "_noah-fake/x.md",
      "/abs/path.md",
      "C:\\windows.md",
      "_NOAH/upper.md", // case-sensitive
    ];
    for (const p of cases) {
      const r = writeNote(p, "nope");
      expect(r.ok).toBe(false);
    }
    // The original notes outside _noah/ must remain untouched.
    expect(readFileSync(resolve(FIXTURE, "intel.md"), "utf-8")).toContain(
      "Market intel",
    );
  });

  test("writeNote DENIES traversal even when prefixed _noah/", () => {
    const r = writeNote("_noah/../escape.md", "nope");
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("denied_traversal");
    expect(existsSync(resolve(FIXTURE, "escape.md"))).toBe(false);
  });

  test("writeNote DENIES Shannon paths", () => {
    const r = writeNote("_noah/shannon-notes.md", "nope");
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("denied_shannon");
  });

  test("writeNote DENIES non-md/json extensions", () => {
    const r = writeNote("_noah/binary.png", "nope");
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("denied_extension");
  });

  test("writeNote DENIES oversized content (>256KB)", () => {
    const big = "x".repeat(257 * 1024);
    const r = writeNote("_noah/big.md", big);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("denied_oversize");
  });

  test("appendToNote creates the file when missing and appends when present", () => {
    rmSync(resolve(FIXTURE, "_noah/append.md"), { force: true });
    let r = appendToNote("_noah/append.md", "line 1\n");
    expect(r.ok).toBe(true);
    r = appendToNote("_noah/append.md", "line 2\n");
    expect(r.ok).toBe(true);
    expect(readFileSync(resolve(FIXTURE, "_noah/append.md"), "utf-8")).toBe(
      "line 1\nline 2\n",
    );
  });

  test("appendToNote enforces the same _noah/ jail as writeNote", () => {
    const r = appendToNote("../outside.md", "nope");
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("denied_prefix");
  });

  test("createDirs:false refuses to mkdir parents (existing dir only)", () => {
    const r = writeNote("_noah/new-tree/deeper/note.md", "x", {
      createDirs: false,
    });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("io_error");
  });
});
