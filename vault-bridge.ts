/**
 * Vault bridge (P3): cross-device sync, session summaries, observations.
 *
 * Noah on each device (Mac, OMEN) writes structured artifacts to the
 * `_noah/` subtree of the shared Obsidian vault. The vault syncs between
 * devices via Obsidian Sync — so on startup, the other device's Noah reads
 * the artifacts and reconciles.
 *
 * Three artifact types:
 *  - memory exports → `_noah/memories/YYYY-MM-DD_<device>.md`
 *  - session summaries → `_noah/sessions/YYYY-MM-DD_<device>_<N>.md`
 *  - observations → `_noah/observations/YYYY-MM-DD.md`
 *
 * Two reliability mechanisms:
 *  1. Incremental writes during the session (best-effort) — every successful
 *     memory_remember updates the day's export file immediately, so a sleep /
 *     kill / crash doesn't lose what's already in memory.db.
 *  2. Startup reconciliation (the reliable path) — query memory.db (and
 *     rootworks db.ts) for anything that hasn't been exported yet and write
 *     it. The DB is source of truth; vault export is derivative.
 *
 * Boundaries:
 *  - WRITE only to `_noah/` (enforced in vault.ts).
 *  - No memory deletion. No write to Noah-Self-Knowledge.md (human-promoted).
 *  - Shannon block applies in vault.ts; this module never inspects vault
 *    content, only emits structured artifacts derived from local state.
 */

import { Database } from "bun:sqlite";
import { resolve } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import { config } from "./config";
import { log } from "./logger";
import { writeNote, appendToNote, vaultProvenance } from "./vault";
import type { Provenance } from "./provenance";
import { memoryClient, type RememberResult } from "./memory-client";
import { DB } from "./db";
import type { Message } from "./model-client";

// ── Types ────────────────────────────────────────────────────────────

export interface ExportedMemoryRow {
  id: string;
  content: string;
  type: string;
  source: string;
  source_ref: string | null;
  confidence: number;
  created_at: string;
}

export interface BridgeManifest {
  /** Last memory-export timestamp this device exported. Used for incremental
   *  reconciliation: any memory with created_at > this gets exported. ISO. */
  lastExportedAt: string;
  /** Files this device has successfully imported from OTHER devices. Keyed by
   *  vault-relative path; value is the memory_ids actually imported (so a
   *  partial re-process can still skip what already landed). */
  imported: Record<string, { importedAt: string; ids: string[] }>;
}

const MEM_DIR = "_noah/memories/";
const SESSION_DIR = "_noah/sessions/";
const OBS_DIR = "_noah/observations/";
const MANIFEST_PATH = "_noah/_manifest.json";

// ── Device + path helpers ────────────────────────────────────────────

export function deviceId(): string {
  return config.vaultBridge.deviceId;
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Memory-export filename for THIS device, today. One file per day per device. */
function todayExportPath(): string {
  return `${MEM_DIR}${todayUTC()}_${deviceId()}.md`;
}

/** Resolve a vault-relative path to absolute (for reads — writes go through vault.ts). */
function vaultAbs(relPath: string): string {
  return resolve(config.vault.path, relPath);
}

// ── Manifest (cached, atomic-ish) ────────────────────────────────────
//
// The manifest is small (<10KB even after months of use) so we rewrite the
// whole file on every change. JSON gives us schema validation for free.

let manifestCache: BridgeManifest | null = null;

function emptyManifest(): BridgeManifest {
  return { lastExportedAt: "1970-01-01T00:00:00.000Z", imported: {} };
}

export function loadManifest(): BridgeManifest {
  if (manifestCache) return manifestCache;
  const abs = vaultAbs(MANIFEST_PATH);
  if (!existsSync(abs)) {
    manifestCache = emptyManifest();
    return manifestCache;
  }
  try {
    const raw = readFileSync(abs, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BridgeManifest>;
    manifestCache = {
      lastExportedAt: parsed.lastExportedAt ?? "1970-01-01T00:00:00.000Z",
      imported: parsed.imported ?? {},
    };
    return manifestCache;
  } catch (err) {
    log("warn", "vault-bridge.manifest.parse_fail", {
      err: err instanceof Error ? err.message : String(err),
    });
    manifestCache = emptyManifest();
    return manifestCache;
  }
}

function saveManifest(m: BridgeManifest): void {
  manifestCache = m;
  const w = writeNote(MANIFEST_PATH, JSON.stringify(m, null, 2), { overwrite: true });
  if (!w.ok) {
    log("error", "vault-bridge.manifest.save_fail", { kind: w.kind, error: w.error });
  }
}

/** Test hook. */
export function resetManifestCache(): void {
  manifestCache = null;
}

// ── Memory-export serialization ──────────────────────────────────────

function frontmatter(fields: Record<string, string | number>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push("---");
  return lines.join("\n");
}

function memoryEntryMarkdown(m: ExportedMemoryRow): string {
  // One H3 heading per memory; bullet list of fields. Human-skim friendly,
  // machine-parseable via the regex parser below. Content can be multi-line
  // — fenced in a quoted block so the H3 boundary is unambiguous.
  return [
    `### mem_${m.id}`,
    `- **content:** ${oneLine(m.content)}`,
    `- **type:** ${m.type}`,
    `- **source:** ${m.source}`,
    `- **trust:** ${m.confidence.toFixed(2)}`,
    `- **source_ref:** ${m.source_ref ?? "(none)"}`,
    `- **created_at:** ${m.created_at}`,
    "",
  ].join("\n");
}

/** Flatten newlines so a multi-line memory body stays on the **content:** line.
 *  Memory contents are typically short (a sentence or two) — this is safe and
 *  keeps the parser simple. */
function oneLine(text: string): string {
  return text.replace(/\r?\n/g, " ⏎ ").trim();
}

function unflattenContent(text: string): string {
  return text.replace(/ ⏎ /g, "\n").trim();
}

/** Build (or rewrite) the day's memory-export file with the supplied entries. */
function writeMemoryExportFile(
  relPath: string,
  memories: ExportedMemoryRow[],
  dateForHeader: string,
): { ok: boolean; bytes?: number; error?: string } {
  const fm = frontmatter({
    device: deviceId(),
    session_date: `${dateForHeader}T00:00:00Z`,
    exported_at: new Date().toISOString(),
    memory_count: memories.length,
  });
  const header = `\n\n## Memories exported from ${deviceId()} session (${dateForHeader})\n\n`;
  const body = memories.map(memoryEntryMarkdown).join("\n");
  const result = writeNote(relPath, fm + header + body, { overwrite: true });
  if (!result.ok) {
    return { ok: false, error: `${result.kind}: ${result.error}` };
  }
  return { ok: true, bytes: result.bytes };
}

// ── Memory-export parser (for the importer) ──────────────────────────

interface ParsedExport {
  device: string;
  sessionDate: string;
  memories: ExportedMemoryRow[];
}

export function parseExportFile(text: string): ParsedExport | null {
  // YAML frontmatter — tolerant: simple key: value lines.
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm: Record<string, string> = {};
  for (const line of fmMatch[1].split("\n")) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.+)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  if (!fm.device) return null;

  const memories: ExportedMemoryRow[] = [];
  // Each memory block starts with `### mem_<id>`; capture the bullet fields.
  // ID character set is intentionally generous (UUIDs, test IDs, future
  // schemes) — the worthiness gate downstream is the real validator.
  const blockRegex =
    /### mem_([A-Za-z0-9_-]+)\n((?:- \*\*[a-z_]+:\*\*.*\n?)+)/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const id = blockMatch[1];
    const fields: Record<string, string> = {};
    for (const line of blockMatch[2].split("\n")) {
      const m = line.match(/^- \*\*([a-z_]+):\*\*\s*(.+)$/);
      if (m) fields[m[1]] = m[2].trim();
    }
    if (!fields.content) continue;
    memories.push({
      id,
      content: unflattenContent(fields.content),
      type: fields.type ?? "fact",
      source: fields.source ?? "conversation",
      source_ref: fields.source_ref === "(none)" ? null : (fields.source_ref ?? null),
      confidence: parseFloat(fields.trust ?? "0.85"),
      created_at: fields.created_at ?? new Date().toISOString(),
    });
  }

  return {
    device: fm.device,
    sessionDate: fm.session_date ?? `${todayUTC()}T00:00:00Z`,
    memories,
  };
}

// ── memory.db direct READ (for reconciliation) ───────────────────────
//
// We open the memory-api SQLite file in READ-ONLY mode for reconciliation
// queries. The memory-api MCP child has its own write handle; with WAL mode
// (set at the writer), multiple readers are safe. We never write to it from
// here — all memory writes go through the MCP path.

function openMemoryDbReadOnly(): Database | null {
  const sqlitePath =
    config.memory.sqlitePath ||
    resolve(config.memory.memoryApiDir, "data/sqlite/memory.db");
  if (!sqlitePath || !existsSync(sqlitePath)) {
    log("info", "vault-bridge.memdb.missing", { path: sqlitePath });
    return null;
  }
  try {
    return new Database(sqlitePath, { readonly: true });
  } catch (err) {
    log("warn", "vault-bridge.memdb.open_fail", {
      path: sqlitePath,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Pull active memories created since the cutoff (ISO). Read-only. */
function queryMemoriesSince(db: Database, sinceIso: string, userId: string): ExportedMemoryRow[] {
  const rows = db
    .prepare(
      `SELECT id, content, type, source, source_ref, confidence, created_at
       FROM memories
       WHERE user_id = ?
         AND superseded_by IS NULL
         AND created_at > ?
       ORDER BY created_at ASC`,
    )
    .all(userId, sinceIso.replace("T", " ").slice(0, 19)) as ExportedMemoryRow[];
  return rows;
}

// ── EXPORT: incremental + reconciliation ─────────────────────────────

/**
 * Append a single successful memory store to today's export file. Called by
 * noah.ts after memory_remember returns stored:true. Best-effort: if the
 * vault is unavailable, this is a no-op and reconciliation will catch it on
 * the next startup.
 */
export function exportMemoryIncremental(m: ExportedMemoryRow): void {
  if (!config.vaultBridge.enabled) return;
  const path = todayExportPath();
  // We always REWRITE the day's file rather than append-only because the
  // frontmatter (memory_count, exported_at) needs to stay accurate. Reading
  // the file, adding one entry, and rewriting is cheap (daily files are
  // <50KB at typical use). The alternative — append + drift in the
  // frontmatter — is worse for human readability and the importer.
  let existing: ExportedMemoryRow[] = [];
  const abs = vaultAbs(path);
  if (existsSync(abs)) {
    try {
      const text = readFileSync(abs, "utf-8");
      const parsed = parseExportFile(text);
      if (parsed) existing = parsed.memories;
    } catch {
      // Couldn't parse — treat as empty (write a fresh file). The original
      // bytes are preserved if the write fails.
    }
  }
  // Skip if this memory is already in the file (idempotency).
  if (existing.some((e) => e.id === m.id)) return;
  existing.push(m);
  const result = writeMemoryExportFile(path, existing, todayUTC());
  if (result.ok) {
    log("info", "vault-bridge.export.ok", { id: m.id, file: path, total: existing.length });
    // Bump the manifest's high-water mark so reconciliation doesn't re-export.
    const m2 = loadManifest();
    if (m.created_at > m2.lastExportedAt) {
      m2.lastExportedAt = m.created_at;
      saveManifest(m2);
    }
  } else {
    log("warn", "vault-bridge.export.fail", { id: m.id, file: path, error: result.error });
  }
}

/**
 * Catch-up pass on startup: query memory.db for memories created after the
 * last-export watermark; write any that aren't already in their date's
 * export file. This is the RELIABLE mechanism — incremental writes are
 * best-effort, this guarantees nothing is missed.
 */
export function reconcileMemoryExports(): { exported: number; skipped: number } {
  if (!config.vaultBridge.enabled) return { exported: 0, skipped: 0 };
  const db = openMemoryDbReadOnly();
  if (!db) return { exported: 0, skipped: 0 };

  try {
    const manifest = loadManifest();
    const userId = config.memory.userId;
    const recent = queryMemoriesSince(db, manifest.lastExportedAt, userId);
    if (recent.length === 0) {
      log("info", "vault-bridge.export.reconcile.empty", {});
      return { exported: 0, skipped: 0 };
    }

    // Bucket by date so we write each day's file at most once.
    const byDate = new Map<string, ExportedMemoryRow[]>();
    for (const m of recent) {
      const date = m.created_at.slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(m);
    }

    let exported = 0;
    let skipped = 0;
    for (const [date, mems] of byDate) {
      const path = `${MEM_DIR}${date}_${deviceId()}.md`;
      // Merge with any existing entries in that day's file.
      const abs = vaultAbs(path);
      let existing: ExportedMemoryRow[] = [];
      if (existsSync(abs)) {
        try {
          const parsed = parseExportFile(readFileSync(abs, "utf-8"));
          if (parsed) existing = parsed.memories;
        } catch {
          /* treat as empty */
        }
      }
      const seenIds = new Set(existing.map((e) => e.id));
      let added = 0;
      for (const m of mems) {
        if (seenIds.has(m.id)) {
          skipped++;
        } else {
          existing.push(m);
          added++;
        }
      }
      if (added > 0) {
        const r = writeMemoryExportFile(path, existing, date);
        if (r.ok) {
          exported += added;
          log("info", "vault-bridge.export.reconcile.write", {
            file: path,
            added,
            total: existing.length,
          });
        }
      }
    }

    // Update the watermark to the latest created_at we've now exported.
    const latest = recent[recent.length - 1].created_at;
    if (latest > manifest.lastExportedAt) {
      manifest.lastExportedAt = latest;
      saveManifest(manifest);
    }
    return { exported, skipped };
  } finally {
    db.close();
  }
}

// ── IMPORT: from other devices ───────────────────────────────────────

interface ImportSummary {
  filesScanned: number;
  filesImported: number;
  memoriesAttempted: number;
  memoriesStored: number;
  memoriesSkippedDuplicate: number;
  memoriesFailed: number;
}

function listMemoryExportFiles(): string[] {
  const dir = vaultAbs(MEM_DIR);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md") && /^\d{4}-\d{2}-\d{2}_[a-z0-9-]+\.md$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read other-device export files and import any memories that don't already
 * exist locally. Dedupe is exact-content via memory_recall — near-duplicates
 * pass through (acceptable tradeoff for cross-device freshness).
 *
 * Files from THIS device are skipped (we wrote them; we don't need our own
 * exports back). Files already in the manifest's imported-set are skipped
 * unless they contain new memory IDs we haven't seen.
 */
export async function importMemoriesFromOtherDevices(): Promise<ImportSummary> {
  const summary: ImportSummary = {
    filesScanned: 0,
    filesImported: 0,
    memoriesAttempted: 0,
    memoriesStored: 0,
    memoriesSkippedDuplicate: 0,
    memoriesFailed: 0,
  };
  if (!config.vaultBridge.enabled) return summary;

  const myDevice = deviceId();
  const manifest = loadManifest();
  const files = listMemoryExportFiles();

  for (const file of files) {
    summary.filesScanned++;
    // Skip files from this device.
    const deviceMatch = file.match(/^\d{4}-\d{2}-\d{2}_([a-z0-9-]+)\.md$/);
    if (!deviceMatch) continue;
    if (deviceMatch[1] === myDevice) continue;

    const relPath = `${MEM_DIR}${file}`;
    let text: string;
    try {
      text = readFileSync(vaultAbs(relPath), "utf-8");
    } catch (err) {
      log("warn", "vault-bridge.import.read_fail", { file, err: String(err) });
      continue;
    }

    const parsed = parseExportFile(text);
    if (!parsed) {
      log("warn", "vault-bridge.import.parse_fail", { file });
      continue;
    }

    // Already-processed memory IDs for this file.
    const alreadyImported = new Set(manifest.imported[relPath]?.ids ?? []);
    const newlyImported: string[] = [];

    for (const m of parsed.memories) {
      summary.memoriesAttempted++;
      if (alreadyImported.has(m.id)) {
        summary.memoriesSkippedDuplicate++;
        continue;
      }

      // Dedup via recall: exact content match in active memories → skip.
      try {
        const recall = await memoryClient.recall(m.content, { topK: 5 });
        const exact = recall.memories.some((r) => r.content === m.content);
        if (exact) {
          summary.memoriesSkippedDuplicate++;
          newlyImported.push(m.id); // mark as processed so we don't re-check next start
          continue;
        }
      } catch {
        // Recall failed — proceed to attempt the write rather than block sync.
      }

      // Import with explicit:true to bypass the worthiness gate (short cross-
      // device memories should not be silently dropped on the 20-char/3-word
      // minimum). source_ref carries the origin device for forensic trail.
      const result: RememberResult = await memoryClient.remember(m.content, {
        type: m.type as "fact",
        explicit: true,
        sourceRef: `vault-sync:${parsed.device}:${m.source_ref ?? "unknown"}`,
      });
      if (result.stored) {
        summary.memoriesStored++;
        newlyImported.push(m.id);
        log("info", "vault-bridge.import.stored", {
          file,
          fromDevice: parsed.device,
          newId: result.id,
        });
      } else {
        summary.memoriesFailed++;
        log("warn", "vault-bridge.import.fail", {
          file,
          fromDevice: parsed.device,
          kind: result.kind,
          reason: result.reason,
        });
      }
    }

    if (newlyImported.length > 0) {
      manifest.imported[relPath] = {
        importedAt: new Date().toISOString(),
        ids: [...alreadyImported, ...newlyImported],
      };
      summary.filesImported++;
    }
  }

  if (summary.filesImported > 0) saveManifest(manifest);
  log("info", "vault-bridge.import.summary", summary as unknown as Record<string, unknown>);
  return summary;
}

// ── Session summaries (Phase 3) ──────────────────────────────────────
//
// Generated AFTER the conversation, from the persisted rootworks DB. This is
// Option B from the brief: more robust than catching SSE close because the
// DB is the source of truth — if the conversation made it to disk, the
// summary can be generated regardless of how the session ended.

export interface SessionSummary {
  conversationId: string;
  sessionDate: string;
  device: string;
  sessionNumber: number;
  turnCount: number;
  durationEstimateMin: number;
  memoriesStored: number;
  memoriesFailed: number;
  model: string;
  kernel: string;
  /** The model-generated summary body (Markdown). */
  body: string;
}

/** Short, stable identifier for a conversation derived from its UUID. 8 hex
 *  chars (~4B possibilities) is sufficient to disambiguate within a single
 *  device's daily slate; the full UUID also lives in the file's frontmatter. */
function shortConvId(conversationId: string): string {
  return conversationId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
}

/** Build the per-conversation file path. Conversation-ID-based naming
 *  (NOT date-based sequence): idempotency is O(1) `existsSync` on a
 *  deterministic path, so a conversation never gets a second summary when
 *  reconciliation re-runs, and a deleted file never causes the sequence to
 *  drift onto a colliding write target. The date prefix keeps the directory
 *  sortable by day. */
function sessionFilePath(date: string, device: string, conversationId: string): string {
  return `${SESSION_DIR}${date}_${device}_${shortConvId(conversationId)}.md`;
}

/** Compute structural stats from a conversation's persisted messages. The
 *  body itself is generated by the model in summarizeConversation(). */
function statsFromMessages(messages: Array<{ role: string; content: string; metadata: string; created_at: string }>): {
  turnCount: number;
  durationMin: number;
  memoriesStored: number;
  memoriesFailed: number;
  modelId: string;
} {
  const userTurns = messages.filter((m) => m.role === "user").length;
  let durationMin = 0;
  if (messages.length >= 2) {
    const first = new Date(messages[0].created_at).getTime();
    const last = new Date(messages[messages.length - 1].created_at).getTime();
    durationMin = Math.round((last - first) / 60_000);
  }
  let memoriesStored = 0;
  let memoriesFailed = 0;
  let modelId = "";
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    try {
      const meta = JSON.parse(m.metadata || "{}") as {
        tool_calls?: Array<{ name: string; result?: string }>;
        provenance?: { model_id?: string };
      };
      modelId = meta.provenance?.model_id || modelId;
      for (const tc of meta.tool_calls ?? []) {
        if (tc.name !== "memory_remember") continue;
        try {
          const r = JSON.parse(tc.result ?? "{}") as { stored?: boolean };
          if (r.stored) memoriesStored++;
          else memoriesFailed++;
        } catch {
          /* result wasn't JSON */
        }
      }
    } catch {
      /* metadata wasn't JSON */
    }
  }
  return { turnCount: userTurns, durationMin, memoriesStored, memoriesFailed, modelId };
}

/**
 * Generate a session summary via the model. The body is markdown with the
 * sections the brief specifies: What we discussed, Key decisions, Memories
 * stored, Memories that failed to store, Open items, Emotional state.
 *
 * The instruction is explicit: summarize at the discussion/decision level —
 * NOT verbatim. Sensitive details (keys, passwords, IP-adjacent specifics)
 * must be stripped. Shannon content is hard-blocked by the existing vault
 * guards if it somehow lands in the conversation (which would itself be a
 * bug upstream).
 */
async function generateSummaryBody(
  messages: Array<{ role: string; content: string }>,
  modelClient: { chat: (msgs: Message[]) => Promise<{ content: string }> },
): Promise<string> {
  if (messages.length === 0) return "(empty conversation)";

  // Truncate any single message that's absurdly long so the summarizer input
  // stays bounded. Full content of each message; the model can be trusted
  // with the conversation it just participated in.
  const transcript = messages
    .map((m) => `**${m.role}:** ${m.content.slice(0, 2000)}`)
    .join("\n\n");

  const prompt: Message[] = [
    {
      role: "system",
      content:
        "You are summarizing a Noah conversation for a session-record vault note. " +
        "Output ONLY the markdown body — no frontmatter, no surrounding prose, no preamble. " +
        "Sections (in this exact order, in this exact format):\n" +
        "\n" +
        "### What we discussed\n" +
        "(2-4 sentences at the discussion/topic level. Not verbatim.)\n" +
        "\n" +
        "### Key decisions\n" +
        "(Bulleted. Skip if none.)\n" +
        "\n" +
        "### Memories stored\n" +
        "(Bulleted, brief. Skip if none.)\n" +
        "\n" +
        "### Memories that failed to store\n" +
        "(Bulleted, brief. Skip if none.)\n" +
        "\n" +
        "### Open items / follow-ups\n" +
        "(Bulleted, action-oriented. Skip if none.)\n" +
        "\n" +
        "### Root's emotional state / energy\n" +
        "(1-2 sentences. Tone, engagement level, any frustration or excitement noted.)\n" +
        "\n" +
        "Rules:\n" +
        "- Summarize topics; do NOT include verbatim quotes longer than 10 words.\n" +
        "- NEVER include API keys, passwords, secrets, or full file paths to private dirs.\n" +
        "- If a section has no content, write '(none this session)' — don't omit the header.\n" +
        "- Total length: ≤ 500 words.",
    },
    {
      role: "user",
      content: `Summarize this Noah conversation:\n\n${transcript.slice(0, 30_000)}`,
    },
  ];

  try {
    const response = await modelClient.chat(prompt);
    return response.content.trim() || "(model returned empty body)";
  } catch (err) {
    log("warn", "vault-bridge.summary.gen_fail", {
      err: err instanceof Error ? err.message : String(err),
    });
    return `(summary generation failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * Summarize a single conversation and write the result to the vault.
 * Idempotent: if a summary file already exists for this conversation, the
 * function returns the existing path without re-summarizing (unless force).
 */
export async function summarizeConversation(
  conversationId: string,
  modelClient: { chat: (msgs: Message[]) => Promise<{ content: string }> },
  options: { force?: boolean } = {},
): Promise<{ written: boolean; path?: string; reason?: string }> {
  if (!config.vaultBridge.enabled) {
    return { written: false, reason: "vault-bridge disabled" };
  }
  const conv = DB.getConversation(conversationId);
  if (!conv) return { written: false, reason: "conversation not found" };

  const messages = DB.getMessages(conversationId);
  if (messages.length < 2) {
    // No meaningful turn to summarize (just user msg, no assistant reply).
    return { written: false, reason: "too-short" };
  }

  // Use the conversation's creation date as the session date — robust to
  // multi-day conversations (they're rare but the file gets pinned to start).
  const sessionDate = conv.created_at.slice(0, 10);

  // Deterministic, conversation-ID-based path. O(1) existence check is the
  // idempotency primary; the legacy-pattern content scan below is a
  // backwards-compat fallback only.
  const expectedPath = sessionFilePath(sessionDate, deviceId(), conversationId);
  if (existsSync(vaultAbs(expectedPath))) {
    if (!options.force) {
      return { written: false, path: expectedPath, reason: "already-summarized" };
    }
  }

  // Backwards compat: scan ALL existing same-date files for a frontmatter
  // conversation_id match. Catches summaries written by the old sequence-
  // numbered scheme (`{date}_{device}_{N}.md`). Without this, the first run
  // after the fix would re-summarize every legacy file.
  const existingForDate = listSessionFiles(sessionDate, deviceId());
  for (const f of existingForDate) {
    if (`${SESSION_DIR}${f}` === expectedPath) continue; // already checked above
    try {
      const text = readFileSync(vaultAbs(`${SESSION_DIR}${f}`), "utf-8");
      if (text.includes(`conversation_id: ${conversationId}`)) {
        if (!options.force) {
          return {
            written: false,
            path: `${SESSION_DIR}${f}`,
            reason: "already-summarized (legacy)",
          };
        }
      }
    } catch {
      /* skip */
    }
  }

  const stats = statsFromMessages(messages);

  const body = await generateSummaryBody(
    messages.map((m) => ({ role: m.role, content: m.content })),
    modelClient,
  );

  const fm = frontmatter({
    device: deviceId(),
    conversation_id: conversationId,
    session_date: sessionDate,
    turn_count: stats.turnCount,
    duration_estimate_min: stats.durationMin,
    memories_stored: stats.memoriesStored,
    memories_failed: stats.memoriesFailed,
    model: stats.modelId || "(unknown)",
    kernel: "v1.2.0", // current kernel; future: read from kernel.ts loaded version
  });
  const header = `\n\n## Session Summary — ${deviceId()}, ${sessionDate} (${shortConvId(conversationId)})\n\n`;
  const content = fm + header + body + "\n";

  const w = writeNote(expectedPath, content, { overwrite: false });
  if (!w.ok) {
    log("warn", "vault-bridge.summary.write_fail", {
      path: expectedPath,
      kind: w.kind,
      conv: conversationId,
    });
    return { written: false, reason: w.error };
  }
  log("info", "vault-bridge.summary.write_ok", {
    path: expectedPath,
    conv: conversationId,
  });
  return { written: true, path: expectedPath };
}

function listSessionFiles(date: string, device: string): string[] {
  const dir = vaultAbs(SESSION_DIR);
  if (!existsSync(dir)) return [];
  try {
    const prefix = `${date}_${device}_`;
    return readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

/** Read the N most recent session summary files for context injection on
 *  session start. Returns parsed Markdown bodies (the model can read them
 *  directly) sorted newest-first. Each carries Stage-1 provenance — these live
 *  in _noah/ (Noah's own machine-written logs) so they classify as imported
 *  (trust 0.5); the caller surfaces them with that label, never as authoritative. */
export function readRecentSessionSummaries(
  maxFiles = 5,
): Array<{ path: string; text: string; provenance: Provenance; trust: number }> {
  const dir = vaultAbs(SESSION_DIR);
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse() // newest first by lexicographic date prefix
      .slice(0, maxFiles);
    return files.map((f) => {
      const path = `${SESSION_DIR}${f}`;
      const abs = vaultAbs(path);
      let text = "";
      try {
        const buf = readFileSync(abs, "utf-8");
        // Bound each summary at 4KB in the injected context (sessions can
        // grow; we don't want to bloat the system prompt).
        text = buf.slice(0, 4_000);
      } catch {
        /* skip */
      }
      // Classify from the (already-read) head — _noah/ → imported/0.5.
      const prov = vaultProvenance(path, text);
      return { path, text, provenance: prov.provenance, trust: prov.trust };
    });
  } catch {
    return [];
  }
}

/**
 * Reconcile: any conversation in rootworks.db that doesn't have a
 * corresponding summary file gets one. Called on startup.
 *
 * Bounded by `maxSummaries` so a fresh checkout doesn't summarize 500
 * historical conversations on first boot — those can be backfilled later via
 * an explicit script if needed.
 */
export async function reconcileSessionSummaries(
  modelClient: { chat: (msgs: Message[]) => Promise<{ content: string }> },
  maxSummaries = 5,
): Promise<{
  summarized: number;
  alreadySummarized: number;
  tooShort: number;
  failed: number;
  scanned: number;
}> {
  if (!config.vaultBridge.enabled) {
    return { summarized: 0, alreadySummarized: 0, tooShort: 0, failed: 0, scanned: 0 };
  }

  // Recent conversations — ordered by updated_at DESC so we catch the user's
  // most-recent work first when capped by maxSummaries. Widened to 50 (from
  // 20) so the cap is hit by the budget, not by the list size — when 8 new
  // conversations land between boots, we still see all 8.
  const recent = DB.listConversations(50, 0);
  let summarized = 0;
  let alreadySummarized = 0;
  let tooShort = 0;
  let failed = 0;
  for (const conv of recent) {
    if (summarized >= maxSummaries) break;
    const result = await summarizeConversation(conv.id, modelClient);
    if (result.written) {
      summarized++;
    } else if (result.reason?.startsWith("already-summarized")) {
      alreadySummarized++;
    } else if (result.reason === "too-short") {
      tooShort++;
    } else {
      failed++;
      log("warn", "vault-bridge.summary.conv_skipped", {
        conv: conv.id,
        reason: result.reason,
      });
    }
  }
  const breakdown = {
    summarized,
    alreadySummarized,
    tooShort,
    failed,
    scanned: recent.length,
  };
  log("info", "vault-bridge.summary.reconcile", breakdown);
  return breakdown;
}

// ── Observations (Phase 4) ───────────────────────────────────────────
//
// Lightweight structured daily log. Appended to per session — one daily
// file per device gathering rule adherence, recall patterns, behavioral
// notes. Auto-written; NEVER auto-promoted to self-knowledge (that path
// stays human-promoted per the T2.7 design).

export interface SessionObservations {
  conversationId: string;
  sessionDate: string;
  sessionTime: string;
  device: string;
  storeAttempted: number;
  storeSucceeded: number;
  storeFailed: number;
  recallQueriesCount: number;
  recallVagueCount: number;
  recallEmptyCount: number;
  sessionStartBriefFired: boolean;
  selfKnowledgeActive: boolean;
  /** Free-text behavioral notes the agent or analyzer flagged. */
  notes: string[];
}

function observationsFilePath(date: string): string {
  return `${OBS_DIR}${date}.md`;
}

/** Build the markdown block for one session's observations. */
function observationsBlock(o: SessionObservations): string {
  const ratio = o.storeAttempted > 0 ? `${o.storeSucceeded}/${o.storeAttempted}` : "0/0";
  const lines = [
    `## Session ${o.conversationId.slice(0, 8)} (${o.device}, ${o.sessionTime})`,
    "",
    "### Store outcomes",
    `- ${o.storeAttempted} attempted, ${o.storeSucceeded} succeeded, ${o.storeFailed} failed (${ratio} success rate)`,
    "",
    "### Recall quality",
    `- ${o.recallQueriesCount} recall queries this session`,
    `- ${o.recallVagueCount} vague queries (Phase 3B expansion applied)`,
    `- ${o.recallEmptyCount} empty results (recency fallback)`,
    "",
    "### Behavioral notes",
    `- Session prep fired on first message: ${o.sessionStartBriefFired ? "YES" : "no"}`,
    `- Self-knowledge active: ${o.selfKnowledgeActive ? "YES" : "no"}`,
    ...(o.notes.length > 0 ? ["", "### Notes", ...o.notes.map((n) => `- ${n}`)] : []),
    "",
    "***", // horizontal rule between sessions; avoids confusion with `---` frontmatter fence
    "",
  ];
  return lines.join("\n");
}

/** Append a session's observation block to today's observation file.
 *  Creates the file with frontmatter on first write of the day. */
export function appendObservations(o: SessionObservations): void {
  if (!config.vaultBridge.enabled) return;
  const path = observationsFilePath(o.sessionDate);
  const abs = vaultAbs(path);
  const isNew = !existsSync(abs);
  let chunk = observationsBlock(o);
  if (isNew) {
    const fm = frontmatter({
      date: o.sessionDate,
      device: deviceId(),
    });
    chunk =
      fm +
      `\n\n# Observations — ${o.sessionDate} (${deviceId()})\n\n` +
      "_Auto-generated. Root promotes confirmed patterns to Noah-Self-Knowledge.md._\n\n" +
      chunk;
  }
  const r = appendToNote(path, chunk);
  if (!r.ok) {
    log("warn", "vault-bridge.observations.fail", { path, kind: r.kind });
  } else {
    log("info", "vault-bridge.observations.ok", { path, bytes: r.bytes });
  }
}

/** Build a SessionObservations object from a conversation's persisted state.
 *  Used by the startup reconciliation pass for sessions that ended before a
 *  graceful shutdown could write observations. */
export function buildObservationsFromConversation(conversationId: string): SessionObservations | null {
  const conv = DB.getConversation(conversationId);
  if (!conv) return null;
  const messages = DB.getMessages(conversationId);
  if (messages.length === 0) return null;

  let storeAttempted = 0;
  let storeSucceeded = 0;
  let storeFailed = 0;
  let recallQueriesCount = 0;
  let recallVagueCount = 0;
  let recallEmptyCount = 0;
  let sessionStartBriefFired = false;
  let selfKnowledgeActive = false;

  for (const m of messages) {
    if (m.role !== "assistant") continue;
    try {
      const meta = JSON.parse(m.metadata || "{}") as {
        tool_calls?: Array<{ name: string; result?: string; args?: Record<string, unknown> }>;
      };
      for (const tc of meta.tool_calls ?? []) {
        if (tc.name === "memory_remember") {
          storeAttempted++;
          try {
            const r = JSON.parse(tc.result ?? "{}") as { stored?: boolean };
            if (r.stored) storeSucceeded++;
            else storeFailed++;
          } catch {
            storeFailed++;
          }
        } else if (tc.name === "memory_recall") {
          recallQueriesCount++;
          try {
            const r = JSON.parse(tc.result ?? "{}") as { count?: number };
            if (!r.count) recallEmptyCount++;
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* skip malformed metadata */
    }
  }

  // The first assistant message's metadata carries the per-turn flags. (We
  // don't persist the SSE metadata event into the DB today — this is a known
  // shortfall the session-review agent will need to address; for now,
  // session_start_brief and self_knowledge default to false in observations.)

  return {
    conversationId,
    sessionDate: conv.created_at.slice(0, 10),
    sessionTime: conv.created_at.slice(11, 16),
    device: deviceId(),
    storeAttempted,
    storeSucceeded,
    storeFailed,
    recallQueriesCount,
    recallVagueCount,
    recallEmptyCount,
    sessionStartBriefFired,
    selfKnowledgeActive,
    notes: [],
  };
}

/** Reconcile observations for any conversation that doesn't have one yet.
 *  Triggered after summary reconciliation on startup. */
export function reconcileObservations(maxConvs = 5): { written: number } {
  if (!config.vaultBridge.enabled) return { written: 0 };

  const recent = DB.listConversations(20, 0);
  let written = 0;
  for (const conv of recent) {
    if (written >= maxConvs) break;
    // Cheap idempotency: check if today's observation file already mentions
    // this conversation ID prefix.
    const date = conv.created_at.slice(0, 10);
    const path = observationsFilePath(date);
    const abs = vaultAbs(path);
    if (existsSync(abs)) {
      try {
        const text = readFileSync(abs, "utf-8");
        if (text.includes(conv.id.slice(0, 8))) continue;
      } catch {
        /* fall through */
      }
    }
    const obs = buildObservationsFromConversation(conv.id);
    if (!obs) continue;
    appendObservations(obs);
    written++;
  }
  log("info", "vault-bridge.observations.reconcile", { written });
  return { written };
}

