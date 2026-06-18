// Vault content provenance + trust classification — Okeanos Sprint 2 hardening.
//
// SECURITY — DEFAULT-LOW, NARROW-AUTHORED-ALLOWLIST (read before editing lists):
// This module decides whether a surfaced vault file is treated as AUTHORED
// (Root's own writing, trust 0.9) or IMPORTED/UNKNOWN (ingested or unverified
// content, trust 0.5). The conflict detector (Stage 2) injects vault content
// into the model's context, so anything presented as AUTHORED is treated as
// authoritative against the user — an over-trusted file is a prompt-injection
// vector into Noah's own reasoning.
//
// THE POSTURE (flipped 2026-06-18, audit-okeanos-fullstack-2026-06-17):
// authored/0.9 is reachable ONLY via a positive, explicit, UNFORGEABLE signal —
// membership in AUTHORED_ALLOWLIST, a curated set of known-Root-authored
// LOCATIONS. EVERYTHING ELSE — loose-root files, unmarked folders, ingested
// content, anything ambiguous — defaults to 0.5. Trust is granted on the
// PRESENCE of an authorship signal, NEVER on the ABSENCE of a demotion signal
// (the confirmation-bias error disconfirmation-discipline names: "no reason to
// distrust" is not "a reason to trust").
//   - Under-trust is SAFE: Noah surfaces an authored file for confirmation —
//     mild friction, the Elenchus principle handles it gracefully.
//   - Over-trust is the INJECTION VECTOR. So 0.9 is made HARD to reach.
//
// Two live holes this posture closes (audit 2026-06-17):
//   1. LOOSE-ROOT SELF-INJECTION (critical). `folder === ""` used to return 0.9,
//      and the vault root holds Noah-Self-Knowledge.md — a file NOAH ITSELF
//      writes and edits every session. Noah's own output at authored-trust was a
//      self-injection loop into its own conflict-detector. Loose root now → 0.5.
//   2. BULK-IMPORT BLANKET (high). 02-library was folder-authored while 373/475
//      of its files carry `created_by: bulk import` — external scrapes swept in
//      by bulk import kept 0.9. 02-library is no longer allowlisted → 0.5.
//
// And the latent FORGERY: provenance is NEVER read from a field the file
// controls (`created_by`/`author`/`updated_by` inside its own frontmatter) as a
// PROMOTION signal — a file asserting its own authorship is the SEC-1 self-
// promotion class. Authorship comes from LOCATION only (path / an external index
// the content cannot write to). Content-controlled fields are read ONLY to
// DEMOTE (external-ingest markers), never to raise trust.
//
// INTERIM SCALAR — the ideal is an edit-history LOG, not a single trust label;
// vault files are co-edited (Root drafts → agents edit, and vice-versa) and one
// per-file label cannot capture that. Default-low + narrow-authored-allowlist is
// the safe interim until the log exists. See docs/provenance-edit-log-future.md.
//
// PURE MODULE: classification derives from the vault-relative path + the
// already-read frontmatter. It never writes to, moves, or deletes a vault file.
// The fs glue that reads a file's head lives in vault.ts (vaultProvenance()).

export type Provenance = "authored" | "imported" | "unknown";

export interface ProvenanceResult {
  provenance: Provenance;
  /** authored → 0.9; imported/unknown → 0.5 (fail-safe). */
  trust: number;
}

export const TRUST_AUTHORED = 0.9;
export const TRUST_IMPORTED = 0.5; // imported AND unknown both fail-safe to 0.5

// ── THE AUTHORED ALLOWLIST — the ONLY path to 0.9 (audit this list) ───────────
// Top-level vault folders that are GENUINELY Root-authored AND not swept with
// imports. A file reaches authored/0.9 ONLY by living here. Membership is a
// POSITIVE, location-based signal the file's own content cannot forge.
//
// ERR NARROW. A folder left OFF this list defaults to 0.5 — the SAFE direction
// (one extra confirmation). A folder wrongly ADDED is an injection hole. Do NOT
// add a folder unless it is known-Root-authored AND free of ingested / bulk-
// imported / agent-written content. When in doubt, leave it off.
//
// ── FLAGGED FOR OPERATOR CONFIRMATION (2026-06-18 flip) ──
//   ACTIVE (proposed minimal list):
//     "short story" — Root's creative writing; no import pipeline. High confidence.
//   CANDIDATE — left OFF pending operator confirmation:
//     "05-projects" — Root's project notes. Add IFF confirmed free of pasted /
//                     ingested external material. Until confirmed it is 0.5 (safe).
//   DELIBERATELY REMOVED from the old authored set (now default to 0.5):
//     "02-library"        — 373/475 files are `created_by: bulk import` (hole #2)
//     "00-dashboard"      — holds machine-generated daily briefs
//     "_agent","_archive" — agent-written output, not Root-authored
//     loose root ("")     — holds Noah-Self-Knowledge.md, Noah's own writes (hole #1)
export const AUTHORED_ALLOWLIST: ReadonlySet<string> = new Set([
  "short story", // matched case-insensitively (topLevelFolder lowercases)
]);

// Known import / machine-written / mixed folders → imported (0.5). With the
// default-low posture these no longer NEED to demote (the default already does),
// but membership carries the honest `imported` label (vs the default `unknown`)
// so the data-boundary framing names the source correctly.
//   04-intel    : n8n / Readwise signal pipeline (real external content)
//   _noah       : Noah's own machine-written session / observation logs
//   03-outreach : authored relationship notes interleaved with bulk-imported
//                 contacts — mixed, so labeled imported (NO per-file promotion).
export const IMPORT_FOLDERS: ReadonlySet<string> = new Set([
  "04-intel",
  "_noah",
  "03-outreach",
]);

// created_by / generated_by / source values that signal genuinely-external
// ingestion → demote to imported, OVERRIDING the authored allowlist. Lowercased;
// matched exact. Belt-and-suspenders now that the default is already 0.5 — they
// bite only on a file that would otherwise be allowlisted-authored.
export const EXTERNAL_INGEST_MARKERS: ReadonlySet<string> = new Set([
  "n8n auto-detection",
  "auto-ingested",
  "morning-brief",
  "agent-brief", // agent-generated brief (audit-added)
  "bulk-import-scaffold", // scaffold emitted by bulk import, not Root content (audit-added)
  "readwise",
  "omnivore",
  "web-clipper",
  "web clipper",
]);

// frontmatter keys whose value can carry an EXTERNAL-INGEST signal. NOTE: these
// are read ONLY to DEMOTE (toward 0.5), NEVER to promote — provenance is never
// raised to authored on the strength of a content-controlled field (the forgery
// class). Promotion is location-only (AUTHORED_ALLOWLIST).
const ORIGIN_KEYS = ["created_by", "generated_by", "updated_by", "source"] as const;

/**
 * Minimal frontmatter scalar reader. Extracts top-level `key: value` scalar
 * lines from the leading fenced `---` block ONLY. Not a full YAML parser — we
 * need a handful of provenance keys, not arbitrary structure. Read-only; never
 * mutates. Values are lowercased and stripped of surrounding quotes/brackets so
 * `created_by: "[bulk import]"` and `created_by: bulk import` compare equal.
 */
export function parseFrontmatterKeys(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!content || !content.startsWith("---")) return out;
  // closing fence: a line that is exactly --- after the opener
  const end = content.indexOf("\n---", 3);
  const block = end === -1 ? content.slice(3) : content.slice(3, end);
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    let val = line
      .slice(colon + 1)
      .trim()
      .replace(/^["'\[]+|["'\]]+$/g, "")
      .trim()
      .toLowerCase();
    if (key && val && out[key] === undefined) out[key] = val;
  }
  return out;
}

/** External-ingest signal in frontmatter → file originated outside Root's writing. */
function hasExternalIngestMarker(fm: Record<string, string>): boolean {
  for (const key of ORIGIN_KEYS) {
    const v = fm[key];
    if (v && EXTERNAL_INGEST_MARKERS.has(v)) return true;
  }
  // Actual web-clipper signatures (forward-compat — none exist in this vault
  // today, but the Web Clipper plugin would emit these).
  if (fm["clipped"] || fm["clipper"]) return true;
  for (const key of ["url", "link", "source"]) {
    const v = fm[key];
    if (v && /^https?:\/\//.test(v)) return true;
  }
  return false;
}

/** Top-level folder of a vault-relative path, "" for a loose top-level file. */
export function topLevelFolder(relPath: string): string {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const i = norm.indexOf("/");
  return (i === -1 ? "" : norm.slice(0, i)).toLowerCase();
}

/**
 * Stable source label for a provenance value. Consumed by the data-boundary
 * vault wrappers (Stage 1) AND the conflict-detector tag (Stage 2). Lives here
 * (pure, dependency-free) so the detector never has to import from data-boundary.
 */
export function vaultSourceLabel(provenance: Provenance): string {
  switch (provenance) {
    case "authored":
      return "vault_authored";
    case "imported":
      return "vault_imported";
    default:
      return "vault_unknown";
  }
}

const authored = (): ProvenanceResult => ({ provenance: "authored", trust: TRUST_AUTHORED });
const imported = (): ProvenanceResult => ({ provenance: "imported", trust: TRUST_IMPORTED });
const unknown = (): ProvenanceResult => ({ provenance: "unknown", trust: TRUST_IMPORTED });

/**
 * Classify a vault file's provenance + trust. `content` is the file's text (or
 * at least its leading frontmatter); omit it to classify by path alone, which
 * skips the frontmatter-based external-ingest demotion.
 *
 * DEFAULT-LOW precedence (first match wins):
 *   1. external-ingest frontmatter marker → imported (overrides the allowlist)
 *   2. authored allowlist folder          → authored (0.9) — the ONLY path up
 *   3. known import / mixed folder         → imported (0.5, honest label)
 *   4. anything else (loose root, unmarked, undeterminable) → unknown (0.5)
 *
 * There is NO path from folder-absence, loose-root, or a content-controlled
 * frontmatter field to authored. 0.9 requires AUTHORED_ALLOWLIST membership.
 */
export function classifyProvenance(relPath: string, content?: string): ProvenanceResult {
  const fm = content ? parseFrontmatterKeys(content) : {};
  const folder = topLevelFolder(relPath);

  if (hasExternalIngestMarker(fm)) return imported(); // 1 — demotion always wins
  if (AUTHORED_ALLOWLIST.has(folder)) return authored(); // 2 — positive, location-only
  if (IMPORT_FOLDERS.has(folder)) return imported(); // 3 — honest imported label
  return unknown(); // 4 — fail-safe low; no positive signal either way
}
