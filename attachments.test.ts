import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { resolve, join } from "path";
import { config } from "./config";
import {
  formatBytes,
  classifyAttachment,
  resolveWithinRoot,
  extractSummary,
  formatInjectionBlock,
  buildSidecar,
  readAttachmentText,
  processAttachments,
} from "./attachments";

// ── Pure helpers (no fs / config) ────────────────────────────────────────────

describe("formatBytes", () => {
  test("formats across units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4096)).toBe("4.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(undefined)).toBe("unknown size");
  });
});

describe("classifyAttachment", () => {
  test("buckets by extension", () => {
    expect(classifyAttachment("notes.md")).toBe("text");
    expect(classifyAttachment("data.csv")).toBe("text");
    expect(classifyAttachment("script.py")).toBe("text");
    expect(classifyAttachment("report.pdf")).toBe("text"); // extractable
    expect(classifyAttachment("photo.PNG")).toBe("image");
    expect(classifyAttachment("contract.docx")).toBe("binary");
  });
});

describe("resolveWithinRoot (path jail)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rw-root-"));
    mkdirSync(join(root, "data", "uploads", "conv1"), { recursive: true });
    writeFileSync(join(root, "data", "uploads", "conv1", "ok.md"), "hi");
  });

  test("accepts a real file under the root", () => {
    const r = resolveWithinRoot(root, "data/uploads/conv1/ok.md");
    expect(r).not.toBeNull();
    expect(r!.endsWith("ok.md")).toBe(true);
  });

  test("rejects traversal", () => {
    expect(resolveWithinRoot(root, "../../etc/passwd")).toBeNull();
    expect(resolveWithinRoot(root, "data/uploads/../../../secret")).toBeNull();
  });

  test("rejects absolute paths and junk", () => {
    expect(resolveWithinRoot(root, "/etc/passwd")).toBeNull();
    expect(resolveWithinRoot(root, "C:\\Windows\\system32")).toBeNull();
    expect(resolveWithinRoot(root, "")).toBeNull();
    expect(resolveWithinRoot(root, undefined)).toBeNull();
  });

  test("rejects a missing file", () => {
    expect(resolveWithinRoot(root, "data/uploads/conv1/missing.md")).toBeNull();
  });

  test("rejects a symlink that escapes the root", () => {
    const outside = mkdtempSync(join(tmpdir(), "rw-outside-"));
    writeFileSync(join(outside, "secret.md"), "leak");
    const linkPath = join(root, "data", "uploads", "conv1", "escape.md");
    try {
      symlinkSync(join(outside, "secret.md"), linkPath);
    } catch {
      return; // symlink not permitted in this env — skip
    }
    expect(resolveWithinRoot(root, "data/uploads/conv1/escape.md")).toBeNull();
  });
});

describe("extractSummary", () => {
  test("pulls the first non-trivial lines, capped", () => {
    const s = extractSummary("# Title\n\nFirst real line.\nSecond line.\n", 40);
    expect(s.startsWith("Title First real line")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(41);
  });
  test("empty for null", () => {
    expect(extractSummary(null)).toBe("");
  });
});

describe("formatInjectionBlock", () => {
  test("text → fenced spec block", () => {
    const b = formatInjectionBlock({
      filename: "r.md", size: 10, kind: "text", content: "hello", mime: "text/markdown", injectChars: 100,
    });
    expect(b).toContain("[Attached file: r.md (10 B)]");
    expect(b).toContain("hello");
    expect(b).toContain("[End of file]");
  });
  test("image → image tag, no content", () => {
    const b = formatInjectionBlock({
      filename: "p.png", size: 2048, kind: "image", content: null, mime: "image/png", injectChars: 100,
    });
    expect(b).toBe("[Image attached: p.png, 2.0 KB]");
  });
  test("binary → cannot-read tag", () => {
    const b = formatInjectionBlock({
      filename: "c.docx", size: 4096, kind: "binary", content: null,
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", injectChars: 100,
    });
    expect(b).toContain("[Binary file attached: c.docx, 4.0 KB");
    expect(b).toContain("Cannot read inline");
  });
  test("truncates oversized text", () => {
    const b = formatInjectionBlock({
      filename: "big.txt", size: 100, kind: "text", content: "x".repeat(50), mime: "text/plain", injectChars: 10,
    });
    expect(b).toContain("truncated");
    expect(b).toContain("[End of file]");
  });
});

describe("buildSidecar", () => {
  test("includes frontmatter, context, summary, and embedded content", () => {
    const md = buildSidecar({
      originalFilename: "report.md", storedFilename: "report.md", attachedAt: "2026-06-19T10:00:00Z",
      conversationId: "conv-1", mime: "text/markdown", size: 1234, contextHint: "the budget",
      summary: "A budget overview.", embedContent: "line1\nline2", vaultChars: 1000,
    });
    expect(md).toContain("original_filename: report.md");
    expect(md).toContain("provenance: root_direct");
    expect(md).toContain("attached_by: Root");
    expect(md).toContain("## Key content (auto-extracted)");
    expect(md).toContain("A budget overview.");
    expect(md).toContain("## Full content");
    expect(md).toContain("line1");
  });
  test("notes unreadable binary instead of embedding", () => {
    const md = buildSidecar({
      originalFilename: "c.docx", storedFilename: "c.docx", attachedAt: "2026-06-19T10:00:00Z",
      conversationId: "conv-1", mime: "application/octet-stream", size: 9, contextHint: "",
      summary: "", embedContent: null, vaultChars: 1000, unreadableNote: "Content not extractable inline.",
    });
    expect(md).toContain("## Note");
    expect(md).toContain("Content not extractable inline.");
    expect(md).not.toContain("## Full content");
  });
});

// ── Integration: read from a temp "rootworks" + write into a temp vault ───────

describe("processAttachments (read + vault store)", () => {
  let rwRoot: string;
  let vaultRoot: string;
  // Capture/restore the WHOLE vault + attachments config. We assign full
  // sub-objects (not individual keys) so the block is correct even when a sibling
  // test file has globally replaced ./config with a partial stub (bun's
  // mock.module is process-global — see noah.test.ts's header comment).
  let savedVault: typeof config.vault;
  let savedAttachments: typeof config.attachments;

  beforeAll(() => {
    rwRoot = mkdtempSync(join(tmpdir(), "rw-"));
    vaultRoot = mkdtempSync(join(tmpdir(), "vault-"));
    mkdirSync(join(rwRoot, "data", "uploads", "convX"), { recursive: true });
    writeFileSync(
      join(rwRoot, "data", "uploads", "convX", "facts.txt"),
      "Root's dog is named Biscuit.\nThe move is on July 4th.",
    );
    // A natively-storable .md → gets a verbatim copy too.
    writeFileSync(join(rwRoot, "data", "uploads", "convX", "plan.md"), "# Plan\n\nShip on Friday.");
    // An image: exists on disk, never read.
    writeFileSync(join(rwRoot, "data", "uploads", "convX", "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    savedVault = config.vault;
    savedAttachments = config.attachments;
    config.vault = {
      ...(config.vault ?? {}),
      enabled: true,
      path: vaultRoot,
      exclude: [],
      maxFileBytes: 200_000,
      maxResults: 8,
      snippetChars: 240,
      trust: 0.9,
    } as typeof config.vault;
    config.attachments = {
      rootworksRoot: rwRoot,
      maxBytes: 5_000_000,
      injectChars: 8_000,
      vaultChars: 65_536,
    };
  });

  afterAll(() => {
    config.vault = savedVault;
    config.attachments = savedAttachments;
  });

  test("stores a sidecar with embedded content for a .txt and injects it", async () => {
    const out = await processAttachments(
      [{ filename: "facts.txt", mime_type: "text/plain", size: 50, local_path: "data/uploads/convX/facts.txt" }],
      { conversationId: "convX", contextHint: "tell me about my dog" },
    );
    expect(out.count).toBe(1);
    expect(out.contextBlock).toContain("[Attached file: facts.txt");
    expect(out.contextBlock).toContain("Biscuit");
    expect(out.memoryRef).toBe(`attachment:facts.txt:${new Date().toISOString().slice(0, 10)}`);

    const r = out.results[0];
    expect(r.read).toBe(true);
    expect(r.sidecarPath).toBeDefined();
    const sidecarAbs = resolve(vaultRoot, r.sidecarPath!);
    expect(existsSync(sidecarAbs)).toBe(true);
    const sidecar = readFileSync(sidecarAbs, "utf-8");
    expect(sidecar).toContain("Biscuit");
    expect(sidecar).toContain("## Full content");
  });

  test("writes a verbatim copy for .md (no embedded duplicate)", async () => {
    const out = await processAttachments(
      [{ filename: "plan.md", mime_type: "text/markdown", size: 24, local_path: "data/uploads/convX/plan.md" }],
      { conversationId: "convX", contextHint: "" },
    );
    const r = out.results[0];
    expect(r.copyPath).toBeDefined();
    const copyAbs = resolve(vaultRoot, r.copyPath!);
    expect(existsSync(copyAbs)).toBe(true);
    expect(readFileSync(copyAbs, "utf-8")).toContain("Ship on Friday");
    // Sidecar for a verbatim-copied file is a pure metadata record (no embed).
    const sidecar = readFileSync(resolve(vaultRoot, r.sidecarPath!), "utf-8");
    expect(sidecar).not.toContain("## Full content");
  });

  test("acknowledges an image without reading it", async () => {
    const out = await processAttachments(
      [{ filename: "pic.png", mime_type: "image/png", size: 4, local_path: "data/uploads/convX/pic.png" }],
      { conversationId: "convX", contextHint: "" },
    );
    expect(out.contextBlock).toContain("[Image attached: pic.png");
    expect(out.results[0].read).toBe(false);
    // Sidecar still written.
    expect(out.results[0].sidecarPath).toBeDefined();
  });

  test("dedupes a repeated filename (facts.txt → facts_2.txt)", async () => {
    const out = await processAttachments(
      [{ filename: "facts.txt", mime_type: "text/plain", size: 50, local_path: "data/uploads/convX/facts.txt" }],
      { conversationId: "convX", contextHint: "" },
    );
    expect(out.results[0].storedFilename).toBe("facts_2.txt");
  });

  test("handles a missing file gracefully", async () => {
    const out = await processAttachments(
      [{ filename: "ghost.txt", mime_type: "text/plain", size: 1, local_path: "data/uploads/convX/ghost.txt" }],
      { conversationId: "convX", contextHint: "" },
    );
    expect(out.results[0].read).toBe(false);
    expect(out.contextBlock).toContain("not found");
  });

  test("processes multiple files in one turn", async () => {
    const out = await processAttachments(
      [
        { filename: "plan.md", mime_type: "text/markdown", size: 24, local_path: "data/uploads/convX/plan.md" },
        { filename: "pic.png", mime_type: "image/png", size: 4, local_path: "data/uploads/convX/pic.png" },
      ],
      { conversationId: "convX", contextHint: "" },
    );
    expect(out.count).toBe(2);
    expect(out.results).toHaveLength(2);
    expect(out.contextBlock).toContain("plan.md");
    expect(out.contextBlock).toContain("pic.png");
  });
});

describe("readAttachmentText", () => {
  test("reads .ts source as text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "att-"));
    const p = join(dir, "x.ts");
    writeFileSync(p, "export const a = 1;");
    const r = await readAttachmentText(p, "x.ts");
    expect(r.kind).toBe("text");
    expect(r.content).toContain("export const a");
  });
});
