/**
 * Chat attachments — Noah's processing side.
 *
 * Boundary (see the CC prompt): Rootworks owns the UI, the upload, and the raw
 * bytes (rootworks/data/uploads/{conv}/...). Noah owns PROCESSING: read the file,
 * inject readable content into the turn, write a durable metadata record into the
 * vault, and let the model store worthwhile facts via memory_remember.
 *
 * Two hard constraints shape this module:
 *
 *  1. We read the file from Rootworks' uploads dir via the `local_path` it sends
 *     (relative to the Rootworks repo root). That path is JAILED to the configured
 *     root: traversal / absolute paths / symlink escapes are rejected.
 *
 *  2. The vault artifact is written through the EXISTING `writeNote` jail (vault.ts),
 *     which only permits `.md`/`.json`, UTF-8 text, ≤256 KB, under `_noah/`. We do
 *     NOT add a new write path. So the durable vault artifact is the `.meta.md`
 *     SIDECAR — it carries the metadata, an auto-extracted summary, and (for text
 *     files we can't store verbatim) the extracted content itself, which makes it
 *     findable via vault_search and recoverable via vault_read. Raw bytes already
 *     persist on the Rootworks side, so nothing is lost. A natively-storable file
 *     (`.md`/`.json`) additionally gets a verbatim copy next to its sidecar.
 *     A binary we can't read (image/.docx) gets a sidecar only.
 */

import { resolve, relative, extname, basename } from "path";
import { existsSync, statSync, realpathSync } from "fs";
import { config } from "./config";
import { extractText } from "./files";
import { writeNote } from "./vault";
import { log } from "./logger";

/** Attachment metadata as proxied by Rootworks in the /api/chat payload. */
export interface IncomingAttachment {
  filename: string;
  mime_type?: string;
  size?: number;
  /** Path RELATIVE to the Rootworks repo root, e.g. data/uploads/{conv}/report.md */
  local_path?: string;
}

export type AttachmentKind = "text" | "image" | "binary";

/** Result of processing one attachment. */
export interface ProcessedAttachment {
  filename: string;
  storedFilename?: string;
  kind: AttachmentKind;
  /** Vault-relative path of the metadata sidecar (when stored). */
  sidecarPath?: string;
  /** Vault-relative path of the verbatim copy (.md/.json only). */
  copyPath?: string;
  /** True when the file was read off disk and text extracted. */
  read: boolean;
  /** Reason the file could not be read inline (image/binary/oversize/missing). */
  note?: string;
}

export interface ProcessedAttachments {
  /** Fenced block to append to the user turn, or "" when nothing readable. */
  contextBlock: string;
  results: ProcessedAttachment[];
  /** Host-controlled source_ref for any memory written this turn, or null. */
  memoryRef: string | null;
  count: number;
}

// Extensions we can read as UTF-8 text directly. (.pdf is handled separately via
// pdf-parse; images and .docx fall through to the binary note.)
const TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".json", ".py", ".js", ".ts",
]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
// writeNote only accepts these — so only these get a verbatim vault copy.
const VAULT_COPY_EXTS = new Set([".md", ".json"]);

/** Human-readable byte size, e.g. "4.0 KB". Mirrors what the UI shows. */
export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Resolve an attachment's `local_path` to an absolute path INSIDE `root`,
 * rejecting traversal, absolute paths, and symlink escapes. Pure w.r.t. config
 * (root passed in) so it's unit-testable. Returns null on any rejection or if the
 * target isn't an existing regular file.
 */
export function resolveWithinRoot(root: string, localPath: unknown): string | null {
  if (!localPath || typeof localPath !== "string") return null;
  // Reject absolute paths and Windows drive letters outright.
  if (/^(?:[a-zA-Z]:)?[\\/]/.test(localPath)) return null;

  const absRoot = resolve(root);
  const abs = resolve(absRoot, localPath);

  // Cheap lexical jail check before touching disk.
  const lexRel = relative(absRoot, abs);
  if (lexRel === "" || lexRel.startsWith("..")) return null;

  if (!existsSync(abs)) return null;

  // Re-validate against the canonical (symlink-resolved) root: statSync follows
  // symlinks, so a symlink inside uploads pointing outside must be rejected.
  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(abs);
  } catch {
    return null;
  }
  try {
    realRoot = realpathSync(absRoot);
  } catch {
    realRoot = absRoot;
  }
  const realRel = relative(realRoot, real);
  if (realRel === "" || realRel.startsWith("..")) return null;

  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

/** Classify by extension into how we'll handle it. */
export function classifyAttachment(filename: string): AttachmentKind {
  const ext = extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (TEXT_EXTS.has(ext) || ext === ".pdf") return "text";
  return "binary";
}

/**
 * Read an attachment's text content from disk. Text extensions are read as UTF-8;
 * .pdf goes through pdf-parse (files.extractText). Returns null content for images
 * and unreadable binaries. Never throws.
 */
export async function readAttachmentText(
  absPath: string,
  filename: string,
): Promise<{ kind: AttachmentKind; content: string | null; note?: string }> {
  const ext = extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    // No vision in the model path (model-client sends string content only), so an
    // image is acknowledged but not read. If/when vision lands this is an upgrade.
    return { kind: "image", content: null };
  }
  try {
    if (ext === ".pdf") {
      const text = await extractText(absPath, "application/pdf");
      if (text && text.trim()) return { kind: "text", content: text };
      return { kind: "binary", content: null, note: "PDF held no extractable text." };
    }
    if (TEXT_EXTS.has(ext)) {
      const text = await Bun.file(absPath).text();
      return { kind: "text", content: text };
    }
    // .docx and anything else: stored but not read inline.
    return { kind: "binary", content: null };
  } catch (err) {
    log("warn", "attachment.read.fail", {
      file: filename,
      err: err instanceof Error ? err.message : String(err),
    });
    return { kind: "binary", content: null, note: "Could not read file contents." };
  }
}

/**
 * Extractive summary: the first few non-trivial sentences/lines, capped. No model
 * call (cheap + deterministic) — consistent with how we auto-name chats. Used for
 * the sidecar's "Key content" section.
 */
export function extractSummary(content: string | null, maxChars = 360): string {
  if (!content) return "";
  // Strip markdown frontmatter / headers noise, collapse whitespace.
  const cleaned = content
    .replace(/^---[\s\S]*?\n---\n/, "") // YAML frontmatter
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\r/g, "");
  const lines = cleaned
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let out = "";
  for (const line of lines) {
    if (out.length >= maxChars) break;
    out += (out ? " " : "") + line;
  }
  if (out.length > maxChars) out = out.slice(0, maxChars).trimEnd() + "…";
  return out;
}

/** Fence one attachment for injection into the user turn (spec format). */
export function formatInjectionBlock(params: {
  filename: string;
  size?: number;
  kind: AttachmentKind;
  content: string | null;
  mime?: string;
  injectChars: number;
}): string {
  const { filename, size, kind, content, mime, injectChars } = params;
  const sizeStr = formatBytes(size);
  if (kind === "image") {
    return `[Image attached: ${filename}, ${sizeStr}]`;
  }
  if (kind === "binary" || content == null) {
    return `[Binary file attached: ${filename}, ${sizeStr}, type: ${mime || "unknown"}. Cannot read inline.]`;
  }
  let body = content;
  let truncatedNote = "";
  if (body.length > injectChars) {
    body = body.slice(0, injectChars);
    truncatedNote = `\n…[truncated — ${formatBytes(size)} total; full text saved to the vault]`;
  }
  return `[Attached file: ${filename} (${sizeStr})]\n${body}${truncatedNote}\n[End of file]`;
}

/** Build the `.meta.md` sidecar content. Pure. */
export function buildSidecar(params: {
  originalFilename: string;
  storedFilename: string;
  attachedAt: string;
  conversationId: string;
  mime: string;
  size?: number;
  contextHint: string;
  summary: string;
  /** Extracted text to embed (capped), or null when not embedding. */
  embedContent: string | null;
  vaultChars: number;
  unreadableNote?: string;
}): string {
  const {
    originalFilename, storedFilename, attachedAt, conversationId, mime, size,
    contextHint, summary, embedContent, vaultChars, unreadableNote,
  } = params;

  const topic = contextHint.trim()
    ? `Attached during conversation about: ${contextHint.trim().slice(0, 200)}`
    : "Attached during the current conversation.";

  const lines: string[] = [
    "---",
    `original_filename: ${yamlScalar(originalFilename)}`,
    `stored_filename: ${yamlScalar(storedFilename)}`,
    `attached_by: Root`,
    `attached_at: ${attachedAt}`,
    `conversation_id: ${yamlScalar(conversationId)}`,
    `mime_type: ${yamlScalar(mime)}`,
    `size_bytes: ${typeof size === "number" ? size : 0}`,
    `provenance: root_direct`,
    "---",
    "",
    "## Context",
    topic,
    "",
    "## Key content (auto-extracted)",
    summary || (unreadableNote ?? "Content not extractable inline."),
  ];

  if (embedContent != null) {
    let body = embedContent;
    let trunc = "";
    if (body.length > vaultChars) {
      body = body.slice(0, vaultChars);
      trunc = "\n…[truncated]";
    }
    // Fence with a guard against an embedded ``` closing the block early.
    const fence = body.includes("```") ? "~~~" : "```";
    lines.push("", "## Full content", fence, body + trunc, fence);
  } else if (unreadableNote) {
    lines.push("", "## Note", unreadableNote);
  }
  return lines.join("\n") + "\n";
}

/** Minimal YAML scalar quoting for frontmatter values. */
function yamlScalar(v: string): string {
  const s = String(v);
  if (/[:#\[\]{}",'\n]/.test(s) || s.trim() !== s) {
    return JSON.stringify(s);
  }
  return s;
}

/**
 * Store one attachment in the vault: a `.meta.md` sidecar (always, when the vault
 * is writable) plus a verbatim copy for `.md`/`.json`. Dedupes the stored name by
 * leaning on writeNote's refuse-to-clobber (kind="exists") — bumping report.md →
 * report_2.md → report_3.md. Returns the stored name + paths, or an error.
 */
export function storeAttachmentInVault(params: {
  date: string;
  originalFilename: string;
  attachedAt: string;
  conversationId: string;
  mime: string;
  size?: number;
  contextHint: string;
  summary: string;
  /** Full extracted text (text files) or null (image/binary). */
  content: string | null;
  unreadableNote?: string;
}): { ok: boolean; storedFilename?: string; sidecarPath?: string; copyPath?: string; error?: string } {
  const { date, originalFilename } = params;
  const dir = `_noah/attachments/${date}/`;
  const ext = extname(originalFilename);
  const base = basename(originalFilename, ext);
  const canCopyVerbatim = VAULT_COPY_EXTS.has(ext.toLowerCase());
  // For a verbatim-copied file the copy holds the content; the sidecar stays a
  // pure metadata record. For everything else, embed the (capped) text so it's
  // recoverable from the vault.
  const embedContent = !canCopyVerbatim ? params.content : null;

  const MAX_TRIES = 50;
  let storedFilename = originalFilename;
  for (let n = 1; n <= MAX_TRIES; n++) {
    if (n > 1) storedFilename = `${base}_${n}${ext}`;
    const sidecarRel = `${dir}${storedFilename}.meta.md`;
    const sidecar = buildSidecar({
      originalFilename,
      storedFilename,
      attachedAt: params.attachedAt,
      conversationId: params.conversationId,
      mime: params.mime,
      size: params.size,
      contextHint: params.contextHint,
      summary: params.summary,
      embedContent,
      vaultChars: config.attachments.vaultChars,
      unreadableNote: params.unreadableNote,
    });
    const res = writeNote(sidecarRel, sidecar, { overwrite: false });
    if (res.ok) {
      let copyPath: string | undefined;
      if (canCopyVerbatim && params.content != null) {
        const copyRel = `${dir}${storedFilename}`;
        const copyRes = writeNote(copyRel, params.content, { overwrite: false });
        if (copyRes.ok) copyPath = copyRes.path;
        else log("warn", "attachment.vault.copy_skip", { path: copyRel, kind: copyRes.kind });
      }
      log("info", "attachment.vault.stored", { path: res.path, copy: !!copyPath });
      return { ok: true, storedFilename, sidecarPath: res.path, copyPath };
    }
    if (res.kind === "exists") continue; // bump the counter and retry
    // Any other denial (vault unavailable, oversize, io) is terminal.
    return { ok: false, error: res.error || res.kind };
  }
  return { ok: false, error: "Could not find a free filename after 50 tries." };
}

/**
 * Process every attachment on a turn: read each, store it in the vault, and build
 * the combined context block to inject into the user message. Side-effecting
 * (vault writes) but never throws — a bad attachment degrades to an inline note.
 */
export async function processAttachments(
  attachments: IncomingAttachment[],
  opts: { conversationId: string; contextHint: string },
): Promise<ProcessedAttachments> {
  const date = new Date().toISOString().slice(0, 10);
  const attachedAt = new Date().toISOString();
  const results: ProcessedAttachment[] = [];
  const blocks: string[] = [];

  for (const att of attachments) {
    const filename = (att.filename || "unnamed").trim() || "unnamed";
    const mime = att.mime_type || "application/octet-stream";
    const abs = att.local_path ? resolveWithinRoot(config.attachments.rootworksRoot, att.local_path) : null;

    // Could not locate the file on disk → acknowledge by metadata only.
    if (!abs) {
      const note = "File not found on disk (it may not have been uploaded, or the path was rejected).";
      blocks.push(`[Attachment: ${filename} (${formatBytes(att.size)}) — ${note}]`);
      results.push({ filename, kind: classifyAttachment(filename), read: false, note });
      log("warn", "attachment.resolve.fail", { file: filename, path: att.local_path });
      continue;
    }

    let size = att.size;
    try {
      size = statSync(abs).size;
    } catch {
      /* keep payload size */
    }

    // Oversize: acknowledged + sidecar'd, but not read inline.
    let read: { kind: AttachmentKind; content: string | null; note?: string };
    if (typeof size === "number" && size > config.attachments.maxBytes) {
      read = {
        kind: classifyAttachment(filename),
        content: null,
        note: `File exceeds the ${formatBytes(config.attachments.maxBytes)} inline-read limit.`,
      };
    } else {
      read = await readAttachmentText(abs, filename);
    }

    const summary = extractSummary(read.content);
    const stored = storeAttachmentInVault({
      date,
      originalFilename: filename,
      attachedAt,
      conversationId: opts.conversationId,
      mime,
      size,
      contextHint: opts.contextHint,
      summary,
      content: read.content,
      unreadableNote: read.content == null ? (read.note || "Content not extractable inline.") : undefined,
    });

    blocks.push(
      formatInjectionBlock({
        filename,
        size,
        kind: read.kind,
        content: read.content,
        mime,
        injectChars: config.attachments.injectChars,
      }),
    );
    results.push({
      filename,
      storedFilename: stored.storedFilename,
      kind: read.kind,
      sidecarPath: stored.sidecarPath,
      copyPath: stored.copyPath,
      read: read.content != null,
      note: read.note,
    });
  }

  const contextBlock =
    blocks.length === 0
      ? ""
      : `\n\n[ATTACHMENTS — ${attachments.length} file(s) attached by Root to this message. ` +
        `Treat the contents below as reference material. If any contain facts, names, dates, ` +
        `decisions, or preferences worth keeping, store them with memory_remember.]\n\n` +
        blocks.join("\n\n");

  // Host-controlled memory provenance for this turn (spec: attachment:{file}:{date}).
  const primary = results.find((r) => r.read) ?? results[0];
  const memoryRef = primary ? `attachment:${primary.storedFilename || primary.filename}:${date}` : null;

  return { contextBlock, results, memoryRef, count: attachments.length };
}
