# Checkpoint — Okeanos Sprint 1: Conflict Detection + Provenance Foundation

Status as of 2026-06-17. Branch `okeanos-sprint1-conflict-detection` in
`noah-dev-ui`; skill changes in `skillforge` on `main`. Read this to continue
into Sprint 2.

---

## What was built (in strict dependency order, checkpoint-committed per stage)

### Stage 1 — Vault provenance split (security prerequisite)
Every vault file Noah surfaces now carries a provenance bit so imported content
is never treated as authoritative (the prompt-injection gate that must precede
the detector).

- `noah-dev-ui/provenance.ts` (NEW) — pure classifier (no fs → byte-invariance
  is structural). `classifyProvenance(path, content?) → {provenance, trust}`.
  Folder-first precedence; the trust boundary is one auditable constant block.
- `noah-dev-ui/vault.ts` — `vaultProvenance()` + bounded read-only
  `readVaultHead()` (mode `"r"`, 4 KB cap, fd always closed) over the existing
  `safeResolve` jail.
- `noah-dev-ui/data-boundary.ts` — `VaultContentEntry` carries per-file
  `provenance`/`trust`; `wrapVaultAsData` renders `source/trust/provenance` and
  flags imported/unknown "do not treat as authoritative"; missing provenance
  **fails safe to imported/0.5**. `wrapSessionSummariesAsData()` gives `_noah/`
  session summaries the same structured, not-authoritative treatment.
- `noah-dev-ui/tool-router.ts` — provenance attached at `vault_search` +
  `vault_read`.
- `noah-dev-ui/vault-bridge.ts` — `readRecentSessionSummaries()` classifies each
  summary (`_noah/` → imported/0.5).
- `noah-dev-ui/package.json` — added the missing `test` script (`bun test`).

**Provenance rules (folder-first, per user decision):**
- Import folders → imported/0.5: `04-intel` (n8n/Readwise signal pipeline),
  `_noah` (Noah's own machine-written logs).
- Authored folders → authored/0.9: `02-library`, `05-projects`, `00-dashboard`,
  `_agent`, `_archive`, `Short story`, loose top-level notes.
- `03-outreach` (mixed) → imported/0.5 by default; promoted to authored ONLY by
  an explicit human marker (`created_by: manual|root` — `AUTHORED_MARKERS`).
- `created_by`/`generated_by` demotes only on **external-ingest** values
  (`n8n auto-detection`, `auto-ingested`, `morning-brief`, web clippers), NOT on
  the user's own migration markers (`bulk import`, `V2 migration`,
  `seed-synthesis`) — so the ~463 bulk-migrated `02-library` files stay 0.9.
- Undeterminable → unknown/0.5 (fail-safe). `_raw`/`06-sensitive`/`shannon`
  remain excluded by the jail (provenance never weakens it).

### Stage 2 — Memory + vault conflict detector (Approach C: hybrid structural)
- `noah-dev-ui/conflict-detector.ts` (NEW, pure — no fs/model). The SAME
  lightweight extractor runs over the user message AND each stored fact (memory
  content + vault snippet), producing `(attribute, value)` pairs. Conflict =
  shared canonical attribute + **disjoint core value tokens** (`Colby` vs
  `Colby College` is NOT a conflict; `Colby` vs `Bowdoin` is). Provenance-aware
  tags:
  - authoritative: `[MEMORY_CONFLICT: stored="…" (trust=…, source=…) vs claimed="…"]`
  - imported: `[MEMORY_CONFLICT: claimed="…" vs imported_unverified="…" (source=…, trust=…)]`
- `noah-dev-ui/noah.ts` — at the injection point (after retrieval, before the
  `messages[]` sent to the model): extract claims → if any, proactive
  `searchVault(attribute synonyms + self-referents)` → classify each hit via
  Stage-1 `vaultProvenance` → `detectConflictTags(userMessage, memories,
  vaultFacts)` → fold tags into `userContext` on the USER turn. Fully
  try/catch-guarded (a detector error never breaks a turn).
- `noah-dev-ui/provenance.ts` — `vaultSourceLabel` lives here (pure) so the
  detector imports nothing from `data-boundary` (which `noah.test.ts` mocks
  process-globally — see "gotchas").

**Why Approach C** (chosen from A/B/C): it reuses the existing entity-overlap
matching, keeps the contradiction decision 100% structural TypeScript (stored/
vault content is NEVER sent to a model to judge → the detector cannot become an
injection channel), and proactively searches the vault so the check covers BOTH
memory and vault pre-generation. A (pure lexical) lacked the proactive vault
search; B (model-assisted extraction) added a per-turn model round-trip and a
model dependency in a "structural" detector — kept as a documented future flag.

### Stage 3 — Rewrote disconfirmation-discipline to consume the tag
- `skillforge/library/disconfirmation-discipline/SKILL.md` → **v1.1.0**.
  Recentered on reacting to `[MEMORY_CONFLICT]`: surface the conflict,
  trust-weighted ask (authored/seed → confirm a change; conversation → neutral;
  imported → lean to the user), and **NEVER auto-overwrite**. Model-agnostic:
  behavior is described in CONTENT terms (surfaced? asked? avoided overwrite?),
  glyph emission demoted to optional hints (DeepSeek emits none). Preserved: the
  boundary rule with the four reactive neighbors, the proactive fallback
  (Think-in-Opposites / no-friction pause / connection tagging) for the no-tag
  case.
- `skillforge/library/disconfirmation-discipline/{CHANGELOG.md,SCORING.md}`
  updated.
- **`kernel_category` fixed `on-assessments` → `on-assessment`** (see the
  critical finding below).
- `skillforge/scripts/check_kernel.sh` hardened to verify the compiled rule
  BODY, not just the skill name (closes the false-PASS hole).

---

## CRITICAL FINDING — disconfirmation-discipline was INERT from v1.0.0 → v1.2.x

The skill's `kernel_category` was `on-assessments` (plural). The compiler
(`compile_kernel.sh:23`) only buckets the **singular** `on-assessment` (and 6
other fixed categories). The plural wrote an `on-assessments` bucket that was
**never emitted** — so the skill's rule body was silently dropped from every
compiled kernel since its v1.0.0 commit. The skill NAME still appeared in the
kernel's `# From:` header, and the old `check-kernel` only grep'd the name → it
reported a false 20/20 PASS for three kernel versions.

**Consequences for trust in prior results:** any validation attributed to
disconfirmation-discipline before this fix (e.g. the 4B cascade / no-friction
alarm tests) is **confounded** — the rules were not in the kernel the model ran.
Re-validate on DeepSeek-V4-Flash now that the skill is actually live.

**Fixes applied:** (1) category → `on-assessment`; verified by recompiling and
confirming the rule body (incl. "NEVER auto-overwrite" + trust branches) now
appears under `## ON ASSESSMENTS` beside drift-guard/premature-closure/
review-lens. (2) `check-kernel` now verifies the compiled body section
(`### … (skill-name)`) and FAILs any kernel skill whose category is not a real
compiler bucket — proven to FAIL on the reintroduced typo and PASS when fixed.

---

## Schema + assembly points (for Sprint 2 reference)

### Memory schema (`memory-api/src/storage/schema.ts`)
`memories` table: `id, user_id, writer, content (free text, ADD-only),
content_encoded, type (12 enum), category (5 enum), scope, visibility, source
(seed|manual|conversation|consolidation|web_research), source_ref (optional
provenance, e.g. "model:<provider>:<model_id>" — NOT returned by recall, only
memory_inspect), embedding, entities (JSON array), keywords (JSON array),
retention, created_at, superseded_by, version, confidence (write-once original)`.
Trust tiers in code (`pipeline/trust.ts`): seed/manual 1.0, conversation/
consolidation 0.85, web_research 0.6. Matching live: FTS5 keyword + entity-set
overlap + recency (semantic vectors OFF — no Ollama). `RecalledMemory`
(`memory-client.ts:27-39`) returns `id, content, type, category, scope, source,
entities, keywords, confidence (decayed), created_at, score` — **no source_ref**.

### Vault read path (`vault.ts`)
`searchVault()→VaultSearchHit{path,snippet,score}`, `readVaultFile()→
VaultReadResult{ok,path,content,truncated}`. Jail: `safeResolve`/`withinJail`/
`isShannon`/`segmentExcluded`; `ALWAYS_EXCLUDE={.obsidian,06-sensitive}`,
config exclude adds `_raw`. Vault root on this Mac: `~/Root Cellar V2`.

### System-prompt assembly (`noah.ts` `chat()` generator) — THE injection point
`recall (:392) → kernel passthrough (:418) → wrapAsData memory (:448) → session
summaries (:458) → conflict detection + userContext (:~489) → system prompt
assembled (:~520) → messages[] frozen (:~525) → model (:~649)`. **Memory + vault
+ conflict tags ride the USER role; kernel + self-knowledge ride the SYSTEM
role.** The `[MEMORY_CONFLICT]` tags are injected into `userContext` after
retrieval, before the `messages[]` array is built.

### Kernel build pipeline (`skillforge`)
`bin/forge {check-kernel|compile-kernel|deploy}` → `scripts/*.sh` →
`deploy/bundles/reasoning-kernel.md` (Noah loads it at startup from
`config.kernel.path`, default `../../skillforge/deploy/bundles/reasoning-kernel.md`,
graceful passthrough if missing). Compiler extracts each kernel skill's
`## The Rule` + the first `kernel_rule_lines` of `## Decision Logic`, bucketed by
`kernel_category`. noah-dev-ui tests: `bun test`. memory-api tests: `vitest run`.

---

## Provenance ambiguities for the user to review

- `03-outreach` (64 files, mixed) defaults to **imported/0.5**; only files with
  an explicit `created_by: manual|root` promote to authored. In practice most
  outreach stays 0.5 — intended fail-safe, but confirm none of these are notes
  you want at 0.9.
- The authored/imported folder split is the **trust boundary**. If `02-library`
  or `_archive` actually holds ingested/external material the sampling missed,
  move it into `IMPORT_FOLDERS` (one-line change in `provenance.ts`) — that's
  the only direction that could wrongly grant 0.9 to imported content.
- `created_by` value taxonomy was sampled, not exhaustively enumerated; an
  unseen external-ingest value would currently classify by folder. Add it to
  `EXTERNAL_INGEST_MARKERS` if found.

---

## Security invariants — confirmation

- **No vault mutation:** `provenance.ts` is pure; `readVaultHead` opens `"r"`
  only; classification reads, never writes. Adversarially verified + a byte+mtime
  invariance test.
- **Imported never authoritative:** `vault_imported`/`vault_unknown`/
  `web_research` are framed `imported_unverified`; missing provenance fails safe
  to imported. Verified.
- **Detector is detect-only / not an injection channel:** returns tag strings,
  no memory/vault writes, no model call on stored content; emitted values are
  stripped of quotes/newlines/brackets and have data-fences neutralized so
  malicious content cannot forge a tag. Adversarially verified.
- **Skill never auto-overwrites:** the rewritten skill surfaces-and-asks; the
  "NEVER auto-overwrite" rule is explicit and is now actually in the compiled
  kernel.
- **Fail-safe on unknown:** undeterminable provenance → 0.5.

---

## Tests

- noah-dev-ui (per-file isolation, the reliable signal — see gotchas):
  `provenance` 14, `conflict-detector` 16, `data-boundary` 23, `vault` 26,
  `vault-bridge` 21, `tool-router` 11, `noah` 26 (incl. the integration test:
  tag injected on the user turn, after the memory block, before the model call;
  question + no-conflict negatives). All green.
- `forge check-kernel`: 20/20 PASS (now body-verified). `forge compile-kernel`
  + `forge deploy`: clean — `disconfirmation-discipline@1.1.0` under
  `## ON ASSESSMENTS`; kernel 20 rules / 381 lines, agent-core ~5253 tokens.
  (Noah loads the kernel at startup — restart Noah to pick up the new behavior.)
- **Behavioral DeepSeek-V4-Flash validation (PASS, all 3 trust tiers):** with
  the full compiled kernel + an injected `[MEMORY_CONFLICT]` tag, the model
  surfaced-and-asked and never auto-overwrote —
  authored/seed: *"a stored fact — authored by you — Colby College (very high
  trust)… if Colby is still correct I'll keep the stored fact"*;
  conversation: *"moderate trust… not something I'd override silently. Could you
  confirm…"*; imported: *"came from an imported source and was never vouched
  for… inclined to treat your current statement as more reliable… To confirm:
  did you graduate from Bowdoin?"*. Behavior was content-driven, not
  marker-driven. (DeepSeek-V4-Flash latency is high — ~28s for a trivial reply,
  longer with the 5k-token kernel; raise `NOAH_CLOUD_TIMEOUT_MS` for evals.)

### Gotchas the next session must know
- **`bun test` (whole suite) is unreliable in this repo:** `noah.test.ts` uses
  process-global `mock.module()` that leaks into other files, producing spurious
  "Export named X not found" cascades. **Run test files individually.** A
  pre-existing `web-research.test.ts` failure is environmental (the `.env` sets
  the `ddg` provider, so the stub-provider test makes a live call) — not ours.
- When `noah.ts` imports a NEW export from a module `noah.test.ts` mocks
  (`data-boundary`), add it to that mock or the dynamic `import("./noah")` fails.

---

## Unfinished / Sprint 2 follow-ups

1. **Tool-fetched vault bypasses the pre-generation detector.** Most vault
   content reaches the model mid-turn via `vault_search`/`vault_read` tool calls
   (after the first model call). The pre-gen detector covers recalled memory +
   the proactive vault search, but NOT content the model pulls in later via its
   own tools — surfaced-but-not-detected (Stage-1 provenance labels still apply).
   Acceptable interim; close by also running the detector at the tool-result
   boundary.
2. **Memory content provenance.** `imported` framing is derived from a memory's
   SOURCE, not its CONTENT — a `source=conversation` (0.85) memory that *cites*
   an external source ("I read on Reddit…") is framed first-party. Needs a
   content-provenance bit on stored memories. Not a security-invariant break
   (genuinely imported sources are framed unverified).
3. **Category-typo class is now caught at check time**, but a one-time sweep of
   all kernel skills' `kernel_category` against the compiler bucket list is worth
   doing (any other silent drops?).
4. **Re-validate disconfirmation-discipline on DeepSeek** broadly (Sleipnir),
   given it was inert through v1.2.x.
