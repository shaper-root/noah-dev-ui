/**
 * Selective-skill selector + loader (OK-4 loader seam).
 *
 * Closes the gap where Noah loaded only the always-on behavioral kernel
 * (`loadKernel()` → reasoning-kernel.md) and never any `type: selective` task
 * skill. This module reads the selective skills from skillforge's `library/`,
 * runs a CHEAP, DETERMINISTIC keyword match against the user's message, and
 * returns the SKILL.md body(ies) for the matched skill(s) so noah.ts can inject
 * them as an ADDITIVE block alongside — never replacing — the kernel.
 *
 * INVIOLABLE SAFETY PROPERTY: selection only ADDS. When nothing matches,
 * `selectSkills()` returns `[]` and `loadSkillBlock([])` returns `""`, so the
 * assembled system prompt is byte-identical to today. A bug in selection can at
 * worst fail to load a selective skill (a capability miss) — it can never drop
 * or alter a kernel skill (a safety failure), because this module never touches
 * the kernel load path. Same rule the kernel three-ring split will follow.
 *
 * Design mirrors `kernel.ts` / `self-knowledge.ts`:
 *  - The skill files live in skillforge, not this repo. A recompiled/edited
 *    skill is picked up on next restart (registry cached per process).
 *  - Never throws. A missing library, an unparseable skill, an oversized body —
 *    all degrade to "no selection" (passthrough), never a crashed turn.
 *  - Bodies are bounded (MAX_SKILL_BODY_BYTES) and sha256-logged for the
 *    forensic trail, same as the self-knowledge injection.
 *
 * The matcher is intentionally simple and SWAPPABLE: `matchSkills()` is a pure
 * function over parsed skill metadata, so a future version can replace the
 * keyword heuristic with embeddings or a model-confirmed pass WITHOUT touching
 * the injection seam in noah.ts. The kernel three-ring split reuses exactly this
 * shape (a per-turn classifier → an additive block).
 */

import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from "fs";
import { resolve, join, sep } from "path";
import { createHash } from "crypto";
import { config } from "./config";
import { log } from "./logger";
import type { ToolDef } from "./model-client";

/**
 * Hard cap on a single injected skill body. A selective skill body is injected
 * into the system prompt as INSTRUCTION (high trust, fenced but not data) — an
 * unbounded read would let a corrupted/oversized skill balloon the system
 * message. 64KB is generous (cc-prompt-engineer's SKILL.md is ~5KB) and tight
 * enough that surprise growth is caught and degraded to passthrough for that
 * skill. Same defense as self-knowledge's MAX_FILE_BYTES.
 */
const MAX_SKILL_BODY_BYTES = 64 * 1024;

/** Hard cap on an on-demand reference file the model can pull via the tool. */
const MAX_REFERENCE_BYTES = 64 * 1024;

/** Default soft cap on simultaneously-loaded task skills (the protocol's "3"). */
const DEFAULT_MAX_SKILLS = 3;

/** Distinct distinctive DOMAIN tokens (beyond the required authoring verb) a
 *  message must hit to select a skill. */
const MATCH_THRESHOLD = 2;

/**
 * Generic words stripped from triggers before matching. The selective triggers
 * are full sentences full of generic coding/action verbs ("writing", "build",
 * "fix", "feature", "code", "review"…). Counting those as match signal would
 * fire on any coding request. Removing them leaves the DISTINCTIVE tokens a
 * skill actually keys on (for cc-prompt-engineer: claude, cc, prompt,
 * specification, execution). Standard English stopwords are included too.
 */
const GENERIC_STOPWORDS = new Set([
  // articles / prepositions / conjunctions / pronouns
  "a", "an", "the", "or", "and", "for", "to", "of", "in", "on", "at", "by",
  "is", "are", "be", "with", "that", "this", "it", "as", "from", "into", "my",
  "me", "your", "you", "i", "we", "our", "us", "they", "them", "their", "its",
  "no", "not", "do", "does", "if", "so", "but", "about", "over", "per", "via",
  "when", "then", "than", "out", "up", "down", "off", "any", "all", "each",
  // generic coding / action verbs+nouns that are not skill-distinctive
  "write", "writing", "writes", "wrote", "written", "build", "building",
  "builds", "built", "make", "making", "create", "creating", "creates",
  "add", "adding", "change", "changing", "update", "updating", "fix",
  "fixing", "fixes", "review", "reviewing", "improve", "improving",
  "improves", "existing", "code", "coding", "task", "tasks", "feature",
  "features", "function", "file", "files", "thing", "things", "use", "using",
  "help", "want", "need", "get", "got", "new", "before", "after", "should",
  "would", "could", "please", "prepare", "preparing", "design", "designing",
  "execute", "executes", "executing", "execution", "run", "running", "runs",
]);

/**
 * Authoring/editing INTENT verbs. The current selective skills (cc-prompt-engineer,
 * linkedin-writer) are AUTHORING skills — they fire on a request to PRODUCE or
 * REVISE an artifact, not on troubleshooting/discussion that merely mentions the
 * domain. Requiring one of these is what separates "Write a Claude Code prompt to
 * add auth" (fires) from "My prompt to Claude keeps getting cut off" (does not) —
 * the dominant false-positive class the first cut shipped. Request/gerund forms
 * only, deliberately NO bare past tense ("Claude rewrote my prompt" describes
 * Claude's output, not a request) and NO over-generic verbs (make/plan/run/fix).
 * A future NON-authoring selective skill would need the swappable matcher upgraded
 * (see matchSkills) — documented assumption, not a silent constraint.
 */
const ACTION_VERBS = new Set([
  "write", "writing", "draft", "drafting", "compose", "composing", "create",
  "creating", "build", "building", "author", "authoring", "generate",
  "generating", "produce", "producing", "prepare", "preparing", "review",
  "reviewing", "improve", "improving", "revise", "revising", "edit", "editing",
  "rewrite", "rewriting", "refine", "refining", "outline", "outlining",
  // Also-declared trigger verbs of the current skills (linkedin-writer:
  // "Planning…", "Adapting…"). Including them keeps the lexicon consistent with
  // every skill's OWN declared triggers — safe because the verb-object chain
  // still has to resolve to an artifact, so "plan my week" / "adapt to changes"
  // do not fire. Verb-LESS authoring phrasings ("I want a…", "give me a…") are a
  // documented capability MISS, not handled here (those verbs are too generic to
  // add without reopening false positives like "I want my prompt to be faster").
  "plan", "plans", "planning", "adapt", "adapts", "adapting",
]);

/**
 * Generic CONTENT/product nouns that are NOT skill-distinctive. Stripped so a
 * cross-domain "content strategy / topic / channel" question can't masquerade as
 * a domain anchor — linkedin-writer must key on "linkedin", not on "content".
 */
const CONTENT_STOPWORDS = new Set([
  "content", "copy", "strategy", "strategies", "topic", "topics", "channel",
  "channels", "page", "pages", "audience", "brand", "material", "materials",
]);

export interface ParsedSkill {
  /** Skill name from frontmatter `name:` (== library directory name). */
  name: string;
  /** Frontmatter `type:` — only "selective" skills are matched. */
  type: string;
  /** Absolute path to the skill's directory. */
  dir: string;
  /** Verbatim `triggers:` list. */
  triggers: string[];
  /** Verbatim `anti_triggers:` list. */
  antiTriggers: string[];
  /** Basenames of available `references/*.md` files (for the on-demand tool). */
  references: string[];
  /** SKILL.md body (everything after the closing frontmatter `---`), trimmed. */
  body: string;
}

export interface SelectedSkill {
  name: string;
  dir: string;
  /** Match score (count of distinct distinctive trigger tokens hit). */
  score: number;
  references: string[];
}

// ---------------------------------------------------------------------------
// Tokenization helpers (pure)
// ---------------------------------------------------------------------------

/** Lowercase and split into alphanumeric tokens (length >= 2). Non-string in →
 *  [] (the seam's never-throws contract: a bad message must skip selection, never
 *  crash the turn and drop the kernel). */
function tokenize(text: unknown): string[] {
  if (typeof text !== "string") return [];
  const matches = text.toLowerCase().match(/[a-z0-9]+/g);
  return matches ? matches.filter((t) => t.length >= 2) : [];
}

/** Adjacent-token bigrams over the stopword-removed-but-generics-kept stream. */
function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    out.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

/** Standard stopwords only (keep generics — phrases like "build prompt" matter). */
const PLAIN_STOPWORDS = new Set([
  "a", "an", "the", "or", "and", "for", "to", "of", "in", "on", "at", "by",
  "is", "are", "be", "with", "that", "this", "it", "as", "from", "into", "my",
  "me", "your", "you", "i", "we", "our", "us", "they", "them", "their", "its",
]);

function plainTokens(text: string): string[] {
  return tokenize(text).filter((t) => !PLAIN_STOPWORDS.has(t));
}

/**
 * Distinctive DOMAIN tokens a skill keys on: trigger tokens minus generic words,
 * authoring verbs, and generic content nouns. For cc-prompt-engineer this is
 * {prompt, specification, claude, cc, execute, execution}; for linkedin-writer
 * {linkedin, post, pillars, publishing}. These are the anchors a real request to
 * the skill's domain will contain — not the verbs (gated separately) or the
 * cross-domain content nouns (stripped).
 */
function domainTokens(phrases: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of phrases) {
    for (const t of tokenize(p)) {
      if (GENERIC_STOPWORDS.has(t)) continue;
      if (ACTION_VERBS.has(t)) continue;
      if (CONTENT_STOPWORDS.has(t)) continue;
      out.add(t);
    }
  }
  return out;
}

/**
 * Split a skill's distinctive domain tokens into ANCHORS (brand/target tokens —
 * those that appear Capitalized in the triggers: Claude, CC, LinkedIn) and
 * ARTIFACTS (the lowercase deliverable nouns: prompt, specification, post). Case
 * in the declared trigger text is the (generic, no-hardcoding) signal that
 * separates the thing you target from the thing you produce. The sentence-initial
 * word is ignored (its capital is grammatical, not a brand).
 */
function classifyDomain(triggers: string[]): { anchors: Set<string>; artifacts: Set<string> } {
  const domain = domainTokens(triggers);
  const anchors = new Set<string>();
  for (const trig of triggers) {
    const words = trig.split(/\s+/).slice(1); // skip sentence-initial cap
    for (const w of words) {
      const m = w.match(/^[("'\[]*([A-Z][A-Za-z0-9.\-]*)/);
      if (!m) continue;
      const lc = m[1].toLowerCase().replace(/[.\-]/g, "");
      if (domain.has(lc)) anchors.add(lc);
    }
  }
  const artifacts = new Set([...domain].filter((t) => !anchors.has(t)));
  return { anchors, artifacts };
}

/**
 * INTENT GATE: true iff an authoring verb's OBJECT is the skill's artifact — i.e.
 * scanning forward from an ACTION_VERB, skipping determiners/modifiers/anchors,
 * we reach an ARTIFACT token before hitting a foreign content noun. This is what
 * separates "Write a CC PROMPT" / "Draft a LinkedIn POST" (authoring the artifact
 * → fires) from "Compose an EMAIL about Claude Code prompt execution" or "Create
 * a CC EXTENSION that logs every prompt" (authoring a foreign object that merely
 * mentions the domain → does not fire). A foreign content noun between the verb
 * and the artifact breaks the chain — the verb is authoring that, not the skill's
 * deliverable.
 */
function authorsArtifact(
  tokens: string[],
  anchors: Set<string>,
  artifacts: Set<string>,
): boolean {
  const MAX_LOOKAHEAD = 6;
  for (let i = 0; i < tokens.length; i++) {
    if (!ACTION_VERBS.has(tokens[i])) continue;
    let steps = 0;
    for (let j = i + 1; j < tokens.length && steps < MAX_LOOKAHEAD; j++) {
      const t = tokens[j];
      if (artifacts.has(t)) return true; // verb's object IS the artifact
      if (
        anchors.has(t) ||
        PLAIN_STOPWORDS.has(t) ||
        GENERIC_STOPWORDS.has(t) ||
        ACTION_VERBS.has(t) ||
        CONTENT_STOPWORDS.has(t)
      ) {
        steps++;
        continue; // determiner / modifier / brand / co-verb: keep scanning
      }
      break; // a foreign content noun: the verb is authoring something else
    }
  }
  return false;
}

/** Strip parenthetical clauses from a trigger sentence. Anti-triggers often
 *  embed the POSITIVE phrase inside a negating parenthetical — e.g. "Writing code
 *  directly (not writing a prompt for CC to write code)" — whose bigrams
 *  ("writing prompt", "prompt cc") would otherwise veto the exact requests the
 *  skill should serve. The real exclusion is the clause OUTSIDE the parens. */
function stripParens(s: string): string {
  return s.replace(/\([^)]*\)/g, " ");
}

/** Anti-trigger bigrams used as a veto signal (precise; phrase-level). */
function antiPhrases(antiTriggers: string[]): Set<string> {
  const out = new Set<string>();
  for (const a of antiTriggers) {
    for (const b of bigrams(plainTokens(stripParens(a)))) out.add(b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure matcher — swappable without touching the injection seam
// ---------------------------------------------------------------------------

/**
 * Score one skill against a user message. Returns the count of DISTINCT
 * distinctive DOMAIN tokens present, or 0 if vetoed / no authoring intent.
 *
 * Three gates (all must pass for a non-zero score):
 *  1. ANTI-TRIGGER VETO — an anti-trigger bigram present → 0 (excluded task).
 *     Parentheticals are stripped first so an anti-trigger that quotes the
 *     positive phrase in a negation doesn't self-veto legit requests.
 *  2. INTENT GATE — an authoring verb's OBJECT must be the skill's ARTIFACT (see
 *     authorsArtifact). A bare domain mention ("Tell me about Claude Code"), a
 *     no-verb troubleshooting line ("My prompt to Claude got cut off"), or an
 *     authoring request whose object is something ELSE ("Compose an email about
 *     Claude Code prompt execution", "Create a CC extension that logs prompts")
 *     all fail this gate. This is what closed the dominant false-positive class.
 *  3. DOMAIN OVERLAP — count distinct distinctive domain tokens; matchSkills
 *     fires at >= MATCH_THRESHOLD.
 *
 * Deterministic and driven entirely by the skill's DECLARED triggers/anti_triggers
 * (incl. their CASING, which separates brand anchors from artifact nouns) plus
 * the shared verb/content lexicons — no per-skill hand-coding.
 *
 * Heuristic limitation (documented, acceptable as a capability MISS — never a
 * safety failure): a one-word brand spelling ("CCode"), or an artifact request
 * sharing < 2 distinctive domain tokens, is skipped. The veto is bigram-precise.
 * The extensibility point is to swap this for embeddings / a model-confirmed pass.
 */
export function scoreSkill(userMessage: string, skill: ParsedSkill): number {
  const tokens = tokenize(userMessage);
  const msgTokens = new Set(tokens);
  const msgBigrams = new Set(bigrams(plainTokens(userMessage)));

  // (1) Anti-trigger veto: an excluded task scores 0 regardless of overlap.
  for (const ap of antiPhrases(skill.antiTriggers)) {
    if (msgBigrams.has(ap)) return 0;
  }
  // (2) Intent gate: an authoring verb must be producing the skill's artifact.
  const { anchors, artifacts } = classifyDomain(skill.triggers);
  if (!authorsArtifact(tokens, anchors, artifacts)) return 0;

  // (3) Domain overlap.
  const domain = domainTokens(skill.triggers);
  let hits = 0;
  for (const t of domain) {
    if (msgTokens.has(t)) hits++;
  }
  return hits;
}

/**
 * Pure selection over an explicit skill list (no disk). Returns the skills that
 * clear MATCH_THRESHOLD, ranked by score desc, capped at maxSkills. Only
 * `type: selective` skills are considered.
 */
export function matchSkills(
  userMessage: string,
  skills: ParsedSkill[],
  maxSkills: number = DEFAULT_MAX_SKILLS,
): SelectedSkill[] {
  const scored: SelectedSkill[] = [];
  for (const skill of skills) {
    if (skill.type !== "selective") continue;
    const score = scoreSkill(userMessage, skill);
    if (score >= MATCH_THRESHOLD) {
      scored.push({ name: skill.name, dir: skill.dir, score, references: skill.references });
    }
  }
  // Highest score first; stable tie-break by name keeps selection deterministic.
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, maxSkills);
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (minimal, no YAML dependency)
// ---------------------------------------------------------------------------

interface Frontmatter {
  scalars: Record<string, string>;
  lists: Record<string, string[]>;
}

/** Strip surrounding quotes from a YAML scalar/list value. */
function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parse the leading `---`…`---` frontmatter into top-level scalars and
 * simple `key:` + `  - item` lists. Returns the frontmatter and the remaining
 * body. Deliberately minimal — handles exactly the shape selective SKILL.md
 * files use; anything fancier is ignored, never thrown on.
 */
function parseFrontmatter(text: string): { fm: Frontmatter; body: string } {
  const fm: Frontmatter = { scalars: {}, lists: {} };
  if (!text.startsWith("---")) return { fm, body: text.trim() };

  const lines = text.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { fm, body: text.trim() };

  let currentList: string | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentList) {
      fm.lists[currentList].push(unquote(listItem[1]));
      continue;
    }
    const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const val = kv[2];
      if (val === "" || val === ">" || val === "|") {
        // Either a list header (followed by `  - …`) or a folded/block scalar.
        // Treat as a list start; folded scalars simply collect no `- ` items.
        fm.lists[key] = [];
        currentList = key;
      } else {
        fm.scalars[key] = unquote(val);
        currentList = null;
      }
    } else if (!line.match(/^\s+\S/)) {
      // A non-indented, non-kv line ends any open list/scalar context.
      currentList = null;
    }
  }

  const body = lines.slice(end + 1).join("\n").trim();
  return { fm, body };
}

// ---------------------------------------------------------------------------
// Registry: scan skillforge/library for selective skills (cached per process)
// ---------------------------------------------------------------------------

let registryCache: ParsedSkill[] | null = null;

function skillsEnabled(): boolean {
  // Defensive: config.skills may be absent in some test configs → disabled.
  return Boolean(config.skills?.enabled);
}

function libraryDir(): string {
  return config.skills?.libraryDir ?? "";
}

function maxSkills(): number {
  return config.skills?.maxSkills ?? DEFAULT_MAX_SKILLS;
}

/** Parse a single skill directory, or null if it isn't a usable selective skill. */
function parseSkillDir(dir: string): ParsedSkill | null {
  const skillPath = join(dir, "SKILL.md");
  let raw: string;
  try {
    const stat = statSync(skillPath);
    if (!stat.isFile() || stat.size > MAX_SKILL_BODY_BYTES) return null;
    raw = readFileSync(skillPath, "utf-8");
  } catch {
    return null;
  }

  const { fm, body } = parseFrontmatter(raw);
  const name = fm.scalars.name;
  const type = fm.scalars.type ?? "";
  if (!name || type !== "selective") return null;
  if (!body) return null;

  const references: string[] = [];
  const refDir = join(dir, "references");
  try {
    if (existsSync(refDir)) {
      for (const f of readdirSync(refDir)) {
        if (f.endsWith(".md")) references.push(f);
      }
      references.sort();
    }
  } catch {
    /* no references — fine */
  }

  return {
    name,
    type,
    dir,
    triggers: fm.lists.triggers ?? [],
    antiTriggers: fm.lists.anti_triggers ?? [],
    references,
    body,
  };
}

/** Load (and cache) the selective-skill registry from skillforge/library. */
export function loadSkillRegistry(): ParsedSkill[] {
  if (registryCache) return registryCache;
  if (!skillsEnabled()) {
    registryCache = [];
    return registryCache;
  }

  const dir = libraryDir();
  const skills: ParsedSkill[] = [];
  try {
    if (!dir || !existsSync(dir)) {
      log("info", "skills.library_missing", { dir });
      registryCache = [];
      return registryCache;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const parsed = parseSkillDir(join(dir, entry.name));
      if (parsed) skills.push(parsed);
    }
  } catch (err) {
    log("warn", "skills.registry_fail", {
      dir,
      err: err instanceof Error ? err.message : String(err),
    });
    registryCache = [];
    return registryCache;
  }

  registryCache = skills;
  console.log(
    `[skills] Loaded ${skills.length} selective skill(s) from ${dir}: ${skills
      .map((s) => s.name)
      .join(", ") || "(none)"}`,
  );
  log("info", "skills.registry_loaded", { dir, count: skills.length, names: skills.map((s) => s.name) });
  return registryCache;
}

// ---------------------------------------------------------------------------
// Public seam used by noah.ts
// ---------------------------------------------------------------------------

/** Select the task skill(s) for this turn. `[]` when disabled or no match.
 *  CRITICAL: this runs OUTSIDE noah.ts's try/catch, BEFORE the kernel-bearing
 *  system message is assembled. It must NEVER throw — a non-string message
 *  (reachable from an untyped HTTP body) returns [] (skip selection) rather than
 *  aborting the turn and dropping the always-on kernel. */
export function selectSkills(userMessage: unknown): SelectedSkill[] {
  if (!skillsEnabled()) return [];
  if (typeof userMessage !== "string") return [];
  return matchSkills(userMessage, loadSkillRegistry(), maxSkills());
}

function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

export interface SkillBlockResult {
  /** Fenced block to add to the system prompt. "" when no skill selected. */
  text: string;
  /** Rough token estimate of the added text. 0 when empty. */
  tokenEstimate: number;
  /** Names actually injected (a skill whose body fails to load is skipped). */
  injected: string[];
}

/**
 * Build the additive skill block for the selected skills. Each skill's thin
 * SKILL.md body is wrapped in its own sentinel fence (mirroring the kernel /
 * self-knowledge fences) so it is independently isolatable. References are NOT
 * inlined — they load on demand via the skill_reference tool (two-layer
 * pattern). Returns "" for an empty selection → system prompt byte-identical.
 */
export function loadSkillBlock(selected: SelectedSkill[]): SkillBlockResult {
  if (!selected.length) return { text: "", tokenEstimate: 0, injected: [] };

  const blocks: string[] = [];
  const injected: string[] = [];
  const registry = loadSkillRegistry();

  for (const sel of selected) {
    const skill = registry.find((s) => s.name === sel.name);
    if (!skill) continue;
    const refHint = skill.references.length
      ? `\n(Reference files available on demand via the skill_reference tool: ${skill.references.join(", ")}.)`
      : "";
    blocks.push(
      `\n\n=== TASK SKILL: ${skill.name} (selected for this turn) ===\n${skill.body}${refHint}\n=== END TASK SKILL: ${skill.name} ===\n`,
    );
    injected.push(skill.name);
    const sha = createHash("sha256").update(skill.body).digest("hex");
    log("info", "skills.injected", {
      name: skill.name,
      score: sel.score,
      tokens: estimateTokens(skill.body),
      sha256: sha,
    });
  }

  const text = blocks.join("");
  return { text, tokenEstimate: estimateTokens(text), injected };
}

// ---------------------------------------------------------------------------
// On-demand references (two-layer pattern) — gated, whitelisted tool
// ---------------------------------------------------------------------------

/**
 * Build the `skill_reference` tool def for THIS turn, or null when no selected
 * skill has references. The tool's `reference` enum is the WHITELIST of
 * "<skill>/<file>" ids available this turn — the model cannot request anything
 * outside the selected skills' own references/ dirs (closes the
 * Noah→tool→arbitrary-file read that the kernel's security criterion guards).
 */
export function getSkillReferenceTool(selected: SelectedSkill[]): ToolDef | null {
  const ids = referenceWhitelist(selected);
  if (!ids.length) return null;
  return {
    type: "function",
    function: {
      name: "skill_reference",
      description:
        "Load an on-demand reference file for a task skill that is active this " +
        "turn. Call this only when the active skill's guidance points you to a " +
        "reference (e.g. 'See references/prompt-patterns.md'). Returns the file " +
        "text. Only the listed references are available.",
      parameters: {
        type: "object",
        properties: {
          reference: {
            type: "string",
            enum: ids,
            description: "The reference to load, as '<skill>/<file>.md'.",
          },
        },
        required: ["reference"],
      },
    },
  };
}

/** "<skill>/<file>.md" ids for every reference of every selected skill. */
function referenceWhitelist(selected: SelectedSkill[]): string[] {
  const ids: string[] = [];
  for (const sel of selected) {
    for (const ref of sel.references) ids.push(`${sel.name}/${ref}`);
  }
  return ids;
}

/**
 * Dispatch a `skill_reference` tool call. SECURITY: the requested id must be in
 * this turn's whitelist (selected skills only); the path is rebuilt from the
 * skill's own dir, never from model-supplied path segments. Never throws —
 * returns a structured error string like every other tool result.
 */
export function loadSkillReference(
  selected: SelectedSkill[],
  args: Record<string, unknown>,
): string {
  const requested = typeof args.reference === "string" ? args.reference : "";
  const whitelist = new Set(referenceWhitelist(selected));
  if (!whitelist.has(requested)) {
    return JSON.stringify({
      error: `Reference '${requested}' is not available this turn. Available: ${[...whitelist].join(", ") || "(none)"}`,
    });
  }
  const slash = requested.indexOf("/");
  const skillName = requested.slice(0, slash);
  const fileName = requested.slice(slash + 1);
  const sel = selected.find((s) => s.name === skillName);
  if (!sel) return JSON.stringify({ error: `Unknown skill '${skillName}'.` });

  // Rebuild the path from the trusted skill dir + a basename-only file segment.
  // Reject any path traversal in the (already-whitelisted) file segment as
  // belt-and-suspenders.
  if (fileName.includes("/") || fileName.includes("..")) {
    return JSON.stringify({ error: "Invalid reference name." });
  }
  const refRoot = join(sel.dir, "references");
  const path = join(refRoot, fileName);
  try {
    // Canonicalize and CONTAIN: resolve symlinks and confirm the real path stays
    // inside the skill's references/ dir. Closes a supply-chain symlink-exfil
    // vector (a tampered library skill planting references/x.md -> /etc/passwd)
    // even though the model can only name a whitelisted basename. Mirrors the
    // kernel's own Noah->tool->file-read security criterion.
    const realRoot = realpathSync(refRoot);
    const realPath = realpathSync(path);
    if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) {
      return JSON.stringify({ error: "Invalid reference path." });
    }
    const stat = statSync(realPath);
    if (!stat.isFile() || stat.size > MAX_REFERENCE_BYTES) {
      return JSON.stringify({ error: `Reference '${requested}' unavailable.` });
    }
    const text = readFileSync(realPath, "utf-8");
    log("info", "skills.reference_loaded", { reference: requested, tokens: estimateTokens(text) });
    return JSON.stringify({ reference: requested, content: text });
  } catch (err) {
    return JSON.stringify({
      error: `Could not read reference '${requested}': ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/** Test hook: drop the registry cache so the next call re-reads config + disk. */
export function resetSkillRegistryCache(): void {
  registryCache = null;
}
