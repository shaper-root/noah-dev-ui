// Vault content provenance + trust classification — Okeanos Sprint 1, Stage 1.
//
// SECURITY (read this before editing the folder lists below):
// This module decides whether a surfaced vault file is treated as AUTHORED
// (Root's own writing, trust 0.9) or IMPORTED (ingested external/machine
// content, trust 0.5). Imported content is a prompt-injection surface — the
// conflict detector (Stage 2) injects vault content into the model's context,
// so imported content must NEVER be presented as authoritative. Therefore the
// rule fails SAFE: anything not positively identified as authored is demoted to
// imported/unknown (0.5). A file wrongly demoted costs one extra confirmation;
// a file wrongly promoted is an injection vector.
//
// This module is PURE (no filesystem, no mutation): classification is derived
// from the vault-relative path + (optionally) the file's already-read
// frontmatter. It never writes to, moves, or deletes a vault file. The fs glue
// that reads a file's frontmatter lives in vault.ts (vaultProvenance()).
//
// DECISION (Sprint 1, folder-first): the top-level vault folder is the primary
// trust signal. `created_by`/`generated_by` is a NARROW secondary signal that
// only demotes on genuinely-external ingest values (n8n / auto-ingested /
// morning-brief / web clippers) — NOT on the user's own migration markers
// (bulk import / V2 migration / seed-synthesis), which would otherwise wrongly
// demote ~463 authored library files that were bulk-migrated into the vault.

export type Provenance = "authored" | "imported" | "unknown";

export interface ProvenanceResult {
  provenance: Provenance;
  /** authored → 0.9; imported/unknown → 0.5 (fail-safe). */
  trust: number;
}

export const TRUST_AUTHORED = 0.9;
export const TRUST_IMPORTED = 0.5; // imported AND unknown both fail-safe to 0.5

// ── THE TRUST BOUNDARY — audit these lists ───────────────────────────────────
// Top-level vault folders Root authored. Bulk-migrated content here is still
// Root's own curated knowledge → authored. If any of these folders actually
// holds ingested/external material, move it to IMPORT_FOLDERS: a file wrongly
// left here gets 0.9, which is the only direction that opens an injection hole.
export const AUTHORED_FOLDERS: ReadonlySet<string> = new Set([
  "02-library",
  "05-projects",
  "00-dashboard",
  "_agent",
  "_archive",
  "short story", // matched case-insensitively
]);

// Folders that hold ingested / machine-written content → imported (0.5).
//   04-intel : n8n / Readwise signal pipeline (real external content)
//   _noah    : Noah's own machine-written session/observation logs
export const IMPORT_FOLDERS: ReadonlySet<string> = new Set(["04-intel", "_noah"]);

// Mixed folder: authored relationship notes interleaved with bulk-imported
// contacts. Defaults to imported (fail-safe); a per-file authored marker promotes.
export const MIXED_FOLDERS: ReadonlySet<string> = new Set(["03-outreach"]);

// created_by / generated_by / source values that signal genuinely-external
// ingestion → demote even inside an authored folder. Lowercased; matched exact.
export const EXTERNAL_INGEST_MARKERS: ReadonlySet<string> = new Set([
  "n8n auto-detection",
  "auto-ingested",
  "morning-brief",
  "readwise",
  "omnivore",
  "web-clipper",
  "web clipper",
]);

// Explicit human-authorship markers — the ONLY values that promote a MIXED-folder
// (03-outreach) file from the imported default to authored. FAIL-SAFE: an
// unrecognized created_by value must NOT promote — a tampered or bulk-imported
// contact in 03-outreach must never reach 0.9 (that is the injection vector this
// folder is most exposed to). Extend this allowlist deliberately, never with a
// catch-all that promotes "any value I don't recognize".
export const AUTHORED_MARKERS: ReadonlySet<string> = new Set(["manual", "root"]);

// frontmatter keys whose value can carry a provenance signal.
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

/** True if the user's own migration op (not an authorship signal, not external). */
function isNeutralMigration(value: string): boolean {
  return (
    value.startsWith("bulk import") ||
    value.startsWith("v2 migration") ||
    value.startsWith("seed-synthesis")
  );
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

/**
 * Positive authorship signal, used ONLY to promote a file in a MIXED folder
 * (03-outreach) from the imported default to authored. Requires an EXPLICIT
 * human-authorship marker (AUTHORED_MARKERS allowlist). An unrecognized value
 * does NOT promote — fail-safe, so a tampered/bulk-imported contact stays 0.5.
 */
function hasAuthoredMarker(fm: Record<string, string>): boolean {
  for (const key of ["created_by", "author", "updated_by"]) {
    const v = fm[key];
    if (v && AUTHORED_MARKERS.has(v)) return true;
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
 * skips the frontmatter-based external/authored signals.
 *
 * Precedence (first match wins):
 *   1. external-ingest frontmatter marker → imported (overrides folder)
 *   2. designated import folder           → imported
 *   3. mixed folder (03-outreach)         → imported, unless authored marker → authored
 *   4. authored folder OR loose top note  → authored
 *   5. anything else / undeterminable     → unknown (fail-safe, 0.5)
 */
export function classifyProvenance(relPath: string, content?: string): ProvenanceResult {
  const fm = content ? parseFrontmatterKeys(content) : {};
  const folder = topLevelFolder(relPath);

  if (hasExternalIngestMarker(fm)) return imported(); // 1
  if (IMPORT_FOLDERS.has(folder)) return imported(); // 2
  if (MIXED_FOLDERS.has(folder)) return hasAuthoredMarker(fm) ? authored() : imported(); // 3
  if (AUTHORED_FOLDERS.has(folder) || folder === "") return authored(); // 4
  return unknown(); // 5
}
