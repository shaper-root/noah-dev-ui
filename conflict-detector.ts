// Conflict detector — Okeanos Sprint 1, Stage 2 (Approach C: hybrid structural).
//
// WHAT IT DOES: before the user's claim reaches the model, check it against
// BOTH stored memory AND vault content. If a checkable assertion (entity + a
// claimed value) contradicts a stored value, emit a provenance-aware
// [MEMORY_CONFLICT] tag for injection into context after retrieval, before
// generation. It DETECTS + TAGS only — it never resolves the conflict, never
// picks a winner, never mutates memory or vault. Resolution is the
// disconfirmation-discipline skill (Stage 3) + the human (the Elenchus
// principle: surface, never auto-overwrite).
//
// SECURITY: the contradiction decision is 100% structural TypeScript. Stored
// and vault content is NEVER sent to a model to "judge" — so this detector
// cannot become a prompt-injection channel. The tag is provenance-framed:
// an imported/unverified source is explicitly flagged so it is never presented
// as authoritative. This module is PURE (no fs, no model) and therefore
// trivially testable; the orchestration (proactive vault search) lives in
// noah.ts and feeds classified vault entries in.
//
// MECHANISM: the SAME lightweight extractor runs over the user's message and
// over each stored fact, turning free text into (attribute, value) pairs. A
// conflict is a shared canonical attribute with disjoint "core" value tokens
// (so "Colby" vs "Colby College" is NOT a conflict, but "Colby" vs "Bowdoin"
// is). This is deliberately high-precision over high-recall: a missed conflict
// costs nothing here (the model still sees the memory), a false conflict costs
// one wasted question. A model-assisted extractor (Approach B) can later be
// dropped in behind a flag for phrasing robustness without changing this
// contract.

import type { RecalledMemory } from "./memory-client";
import { type Provenance, vaultSourceLabel } from "./provenance";
import { neutralizeFramingChars } from "./data-framing";

/** A vault file surfaced for conflict-checking, already provenance-classified. */
export interface VaultFactInput {
  path: string;
  /** snippet (search) or full content (read). */
  text: string;
  provenance: Provenance;
  trust: number;
}

export interface Claim {
  /** canonical attribute: "school" | "employer" | "residence" | "origin" | "name" | "attr:<x>" */
  attribute: string;
  /** claimed value, surface form */
  value: string;
  raw: string;
}

interface StoredFact extends Claim {
  /** memory source (seed/manual/conversation/...) or vault_authored/vault_imported/vault_unknown */
  source: string;
  trust: number;
  /** framing: an imported/unverified source must never be presented as authoritative */
  imported: boolean;
}

export interface Conflict {
  userValue: string;
  storedValue: string;
  attribute: string;
  source: string;
  trust: number;
  imported: boolean;
}

const MAX_TAGS = 5; // never flood context — surface the top conflicts only.
const MAX_VALUE_LEN = 80;

// ── memory source → trust ────────────────────────────────────────────────────
// Mirrors data-boundary.trustScore and memory-api/pipeline/trust.ts SOURCE_TRUST.
// Kept local so the detector imports nothing from data-boundary (which is
// process-globally mocked in noah.test.ts) — see the mock-completeness note there.
const MEMORY_SOURCE_TRUST: Record<string, number> = {
  seed: 1.0,
  manual: 1.0,
  conversation: 0.85,
  consolidation: 0.85,
  web_research: 0.6,
};
function memoryTrust(source: string): number {
  return MEMORY_SOURCE_TRUST[source] ?? 0.5;
}
/** A stored fact is "imported/unverified" (framed accordingly) when its source
 *  was never vouched for: low-trust memory (web research) or non-authored vault. */
function isImportedSource(source: string, trust: number): boolean {
  return (
    source === "web_research" ||
    source === "vault_imported" ||
    source === "vault_unknown" ||
    trust <= 0.6
  );
}

// ── canonical attributes ─────────────────────────────────────────────────────
const ATTR_CANON: Record<string, string> = {
  school: "school", college: "school", university: "school", "alma mater": "school",
  schooling: "school", education: "school",
  employer: "employer", company: "employer", workplace: "employer", job: "employer",
  work: "employer",
  residence: "residence", home: "residence", address: "residence",
  hometown: "origin", birthplace: "origin", origin: "origin",
  name: "name",
};

// Conversational, non-factual generic attributes that should NOT fire a conflict
// ("my point is …", "my question is …"). Reduces noise from the generic pattern.
const GENERIC_ATTR_DENY = new Set([
  "point", "question", "concern", "issue", "problem", "understanding", "sense",
  "take", "guess", "thought", "hunch", "worry", "fear", "hope", "plan", "idea",
]);

function canonAttr(raw: string): string {
  const k = raw.toLowerCase().trim().replace(/\s+/g, " ");
  return ATTR_CANON[k] ?? `attr:${k}`;
}

// ── value-position pattern + assertion patterns ──────────────────────────────
// VAL captures a proper-noun-ish phrase (leading capital/digit). It contains NO
// capturing groups (uses (?:...)) so the declared group numbers stay stable.
const VAL = `[A-Z0-9][\\w.&'’-]*(?:\\s+(?:of\\s+|the\\s+)?[A-Z0-9][\\w.&'’-]*){0,4}`;

interface PatternDef {
  re: RegExp;
  attr?: string; // fixed canonical attribute
  attrGroup?: number; // capture group holding the attribute word (generic)
  valGroup: number;
}
function P(src: string, opts: { attr?: string; attrGroup?: number; valGroup: number }): PatternDef {
  return { re: new RegExp(src, "i"), ...opts };
}

// Subjects are first-person OR the user's known self-referents (memories/vault
// notes about Root are written in the third person, e.g. "Root graduated from…").
const PATTERNS: PatternDef[] = [
  // school
  P(`\\b(?:i|root|craig)\\s+graduated\\s+from\\s+(${VAL})`, { attr: "school", valGroup: 1 }),
  P(`\\b(?:i|root|craig)\\s+(?:went\\s+to|attended|studied\\s+at)\\s+(${VAL})`, { attr: "school", valGroup: 1 }),
  P(`\\b(?:my|root's|craig's)\\s+(?:alma\\s+mater|college|university|school)\\s+(?:is|was)\\s+(${VAL})`, { attr: "school", valGroup: 1 }),
  // employer
  P(`\\b(?:i|root|craig)\\s+work(?:s|ed)?\\s+(?:at|for)\\s+(${VAL})`, { attr: "employer", valGroup: 1 }),
  P(`\\b(?:my|root's|craig's)\\s+(?:employer|company)\\s+(?:is|was)\\s+(${VAL})`, { attr: "employer", valGroup: 1 }),
  // residence
  P(`\\b(?:i|root|craig)\\s+live[sd]?\\s+in\\s+(${VAL})`, { attr: "residence", valGroup: 1 }),
  // origin
  P(`\\b(?:i|root|craig)\\s+(?:was\\s+born\\s+in|grew\\s+up\\s+in)\\s+(${VAL})`, { attr: "origin", valGroup: 1 }),
  P(`\\b(?:i\\s*'?m|i\\s+am|root\\s+is|craig\\s+is)\\s+from\\s+(${VAL})`, { attr: "origin", valGroup: 1 }),
  // name
  P(`\\b(?:my|root's|craig's)\\s+name\\s+(?:is|was)\\s+(${VAL})`, { attr: "name", valGroup: 1 }),
  // generic possessive (lowest priority) — "my <attr> is <Value>"
  P(`\\b(?:my|root's|craig's)\\s+([a-z][a-z ]{1,28}?)\\s+(?:is|was|are|were)\\s+(${VAL})`, { attrGroup: 1, valGroup: 2 }),
];

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function sanitizeValue(value: string): string {
  // Fence + entry-frame neutralization (strip <<<,>>>, quotes, newlines, square
  // brackets) is shared with data-boundary's serializer via
  // data-framing.neutralizeFramingChars — the single defense that stops a
  // malicious stored value from closing the quoted field early, breaking a
  // line, or forging a second [MEMORY_CONFLICT] tag once interpolated. (The VAL
  // char-class already excludes brackets at capture time; this is explicit
  // defense-in-depth so the guarantee survives any future loosening.) The rest
  // — whitespace collapse, trim, length cap — is local to the short tag value.
  return neutralizeFramingChars(value)
    .replace(/\s+/g, " ")
    .trim()
    // strip leading/trailing punctuation (sentence period, comma, quote) without
    // touching internal punctuation like "St. Mary's" or "O'Brien".
    .replace(/^[.,;:!?'"\s]+/, "")
    .replace(/[.,;:!?'"\s]+$/, "")
    .slice(0, MAX_VALUE_LEN);
}

// Lowercase tokens allowed INSIDE a proper-noun phrase (only when flanked by
// capitalized words): "University of Maine", "Smith & Wesson". Excludes filler
// like "in"/"at"/"since" so a captured value stops at the first non-name word.
const VALUE_CONNECTORS = new Set(["of", "the", "de", "von", "van", "&", "and"]);

/**
 * Keep only the leading proper-noun phrase of a captured value. The patterns
 * run case-insensitively (so keywords match at sentence start), which means the
 * value capture can over-run into lowercase filler ("Colby College in 2005").
 * This trims to the capitalized head: "Colby College".
 */
function trimToProperNoun(value: string): string {
  const tokens = value.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^[A-Z0-9]/.test(t)) {
      out.push(t);
      continue;
    }
    const next = tokens[i + 1];
    if (VALUE_CONNECTORS.has(t.toLowerCase()) && next && /^[A-Z0-9]/.test(next)) {
      out.push(t);
      continue;
    }
    break;
  }
  return out.join(" ");
}

/**
 * Extract checkable (attribute, value) claims from free text. Skips questions.
 * High precision: only matches explicit identity-style assertions with a
 * proper-noun value. Returns [] for opinions/questions/requests.
 */
export function extractClaims(text: string): Claim[] {
  if (!text) return [];
  const claims: Claim[] = [];
  const seen = new Set<string>();
  for (const seg of splitSentences(text)) {
    if (seg.includes("?")) continue; // questions are not assertions
    for (const p of PATTERNS) {
      const m = seg.match(p.re);
      if (!m) continue;
      const value = trimToProperNoun(sanitizeValue(m[p.valGroup] || ""));
      // Proper-noun gate: the case-insensitive patterns would otherwise capture
      // lowercase values (e.g. "my favorite color is blue"). trimToProperNoun
      // yields "" for a lowercase-initial value; require an uppercase/digit start.
      if (!value || !/^[A-Z0-9]/.test(value)) continue;
      const attribute = p.attr ?? canonAttr(m[p.attrGroup!] || "");
      if (attribute.startsWith("attr:") && GENERIC_ATTR_DENY.has(attribute.slice(5)))
        continue;
      const key = attribute + "=" + normalizeValue(value);
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({ attribute, value, raw: m[0].trim() });
    }
  }
  return claims;
}

// ── value comparison ─────────────────────────────────────────────────────────
const VALUE_STOPWORDS = new Set([
  "the", "of", "college", "university", "inc", "llc", "co", "company", "corp", "ltd", "school",
]);
function coreTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[.,;:'"()]/g, "")
      .split(/\s+/)
      .filter((t) => t && !VALUE_STOPWORDS.has(t)),
  );
}
function normalizeValue(value: string): string {
  return [...coreTokens(value)].sort().join(" ");
}
/**
 * Two values (already known to share an attribute) CONFLICT iff their core
 * token sets are non-empty and disjoint. Shared core token ⇒ same entity
 * ("Colby" vs "Colby College") ⇒ NOT a conflict.
 */
export function valuesConflict(a: string, b: string): boolean {
  const ca = coreTokens(a);
  const cb = coreTokens(b);
  if (!ca.size || !cb.size) return false;
  for (const t of ca) if (cb.has(t)) return false;
  return true;
}

// ── stored-fact normalization ────────────────────────────────────────────────
// KNOWN LIMITATION (Sprint 2 follow-up — memory content provenance):
// `imported` framing is derived from the memory's SOURCE, not its CONTENT. A
// conversation memory (source=conversation, 0.85) that merely *cites* an
// external source ("I read on Reddit that …") is framed as first-party "stored="
// rather than imported_unverified — the memory layer carries no marker that the
// user was quoting. This is NOT a security-invariant break (genuinely imported
// sources — web_research / vault_imported / vault_unknown — are still framed
// imported_unverified, and the tag always carries explicit trust=/source= so the
// disconfirmation skill applies the correct trust tier). Closing it properly
// needs a content-provenance bit on stored memories, tracked for Sprint 2.
function storedFromMemory(mem: RecalledMemory): StoredFact[] {
  const source = mem.source;
  const trust = memoryTrust(source);
  const imported = isImportedSource(source, trust);
  return extractClaims(mem.content).map((c) => ({ ...c, source, trust, imported }));
}
function storedFromVault(v: VaultFactInput): StoredFact[] {
  const source = vaultSourceLabel(v.provenance);
  const imported = v.provenance !== "authored";
  return extractClaims(v.text).map((c) => ({ ...c, source, trust: v.trust, imported }));
}

function matchConflicts(userClaims: Claim[], stored: StoredFact[]): Conflict[] {
  const out: Conflict[] = [];
  const seen = new Set<string>();
  for (const uc of userClaims) {
    for (const sf of stored) {
      if (sf.attribute !== uc.attribute) continue;
      if (!valuesConflict(uc.value, sf.value)) continue;
      const key = `${sf.attribute}|${normalizeValue(sf.value)}|${sf.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        userValue: uc.value,
        storedValue: sf.value,
        attribute: uc.attribute,
        source: sf.source,
        trust: sf.trust,
        imported: sf.imported,
      });
      if (out.length >= MAX_TAGS) return out;
    }
  }
  return out;
}

function fmtTrust(t: number): string {
  return t.toFixed(2).replace(/0+$/, "").replace(/\.$/, ".0");
}

/** Render a single conflict as a provenance-aware [MEMORY_CONFLICT] tag. */
export function formatConflictTag(c: Conflict): string {
  if (c.imported) {
    // Imported / unverified: framed so it is NOT presented as authoritative.
    return `[MEMORY_CONFLICT: claimed="${c.userValue}" vs imported_unverified="${c.storedValue}" (source=${c.source}, trust=${fmtTrust(c.trust)})]`;
  }
  // Authored / seed / conversation: the stored value was vouched for.
  return `[MEMORY_CONFLICT: stored="${c.storedValue}" (trust=${fmtTrust(c.trust)}, source=${c.source}) vs claimed="${c.userValue}"]`;
}

/**
 * Search-query terms for the proactive vault check (Approach C): the attribute
 * synonyms + the user's self-referents — NOT the claimed value (a vault note
 * holding the CONTRADICTING value won't contain the user's new value). The
 * caller (noah.ts) runs searchVault with this and classifies the hits.
 */
const ATTR_SEARCH_TERMS: Record<string, string[]> = {
  school: ["college", "university", "school", "graduated", "studied", "alma"],
  employer: ["employer", "company", "work", "job"],
  residence: ["lives", "residence", "address", "based"],
  origin: ["from", "hometown", "born", "birthplace"],
  name: ["name"],
};
export function vaultQueryForClaims(claims: Claim[]): string {
  const terms = new Set<string>(["root", "craig"]);
  for (const c of claims) {
    const syns = ATTR_SEARCH_TERMS[c.attribute] ?? [c.attribute.replace(/^attr:/, "")];
    for (const s of syns) for (const w of s.split(/\s+/)) if (w.length >= 2) terms.add(w);
  }
  return [...terms].join(" ");
}

/**
 * THE detector. Pure over its inputs. Returns zero or more [MEMORY_CONFLICT]
 * tag strings for the caller to inject after retrieval, before generation.
 * Returns [] when the user made no checkable assertion, or nothing contradicts.
 */
export function detectConflictTags(
  userMessage: string,
  memories: RecalledMemory[],
  vaultFacts: VaultFactInput[] = [],
): string[] {
  const userClaims = extractClaims(userMessage);
  if (!userClaims.length) return [];

  const stored: StoredFact[] = [];
  for (const m of memories ?? []) {
    if (m && typeof m.content === "string") stored.push(...storedFromMemory(m));
  }
  for (const v of vaultFacts ?? []) {
    if (v && typeof v.text === "string") stored.push(...storedFromVault(v));
  }

  return matchConflicts(userClaims, stored).map(formatConflictTag);
}
