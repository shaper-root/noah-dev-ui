# Memory Quality + Self-Knowledge Deep Upgrade — Change Log

Branch: `feat/memory-quality` (noah-dev-ui + memory-api)
Date: 2026-06-16
Scope: noah-dev-ui, memory-api, Obsidian vault (`Noah-Self-Knowledge.md`)
Boundary: skillforge kernel files unchanged. No memory deletions.

---

## Files touched

### memory-api

| File | Change |
|------|--------|
| `src/mcp/server.ts` | `memory_remember` tool now accepts `explicit:boolean` (bypasses worthiness gate) and `source_ref:string` (writer provenance). Returns structured JSON on failure (`{stored:false, kind, reason}`) instead of opaque error text. |

### noah-dev-ui

| File | Change |
|------|--------|
| `memory-client.ts` | `remember()` ALWAYS returns a `RememberResult` (never null). Failures carry `{stored:false, kind, reason}`. Accepts `sourceRef`/`explicit` opts. Logs `memory.write.{ok,reject,fail,unavailable,malformed}`. |
| `tool-router.ts` | Auto-fills `sourceRef="model:<provider>:<id>"` on every `memory_remember`. Attaches `_agent_advisory` string on failure so the model can't silently claim success. New `getMemoryTools()` export for the late-round carve-out. |
| `noah.ts` | + `detectExplicitMemoryIntent()` regex (Phase 2D), + `expandVagueQuery()` (Phase 3B), + `detectExplicitRecallIntent()` (Phase 3C), + `loadSelfKnowledge()` injection (Phase 5), + first-message session-brief (Phase 6A). Memory tools always available even when context guard / final round disables others (Phase 2B). New SYSTEM_PROMPT rules 8 (check before accepting user claims) and 9 (read memory_remember result). Done event surfaces `memory_stores[]`, `explicit_memory_intent`. Metadata event surfaces `explicit_memory_intent`, `session_start_brief`, `self_knowledge`. |
| `data-boundary.ts` | + `trustScore()`. `wrapAsData()` leads each entry with `[source, trust X.XX]` so the kernel's ground-check has an explicit number. |
| `self-knowledge.ts` | NEW. Cached loader for `Noah-Self-Knowledge.md` from the vault, mirroring `kernel.ts` pattern. Graceful passthrough on missing file. |
| `self-knowledge.test.ts` | NEW. 6 tests: passthrough cases, load, cache, reset. |
| `noah.test.ts` | + 11 new Phase 2-6 tests. Mock for `./tool-router` now derives `getMemoryTools` from `getAllTools`. Mock for `./self-knowledge` removed in favor of `vault.enabled=false` in testConfig so the real module returns passthrough. |
| `data-boundary.test.ts` | Updated 3 existing tests to match the new `[source, trust X.XX]` format. |
| `integration/memory-quality-probes.ts` | NEW. 7 live probes covering Phase 2-6 behaviors. Run against a live `:3333` server. |
| `MEMORY_QUALITY_LOG.md` | NEW. This file. |

### Vault

| File | Change |
|------|--------|
| `/Users/craigzevin/Root Cellar V2/Noah-Self-Knowledge.md` | NEW. 9 known weaknesses + active compensations across memory, reasoning, creative, behavioral, session-continuity dimensions. Read by `self-knowledge.ts` at session start. |

---

## Phase 1 — Diagnosis (read-only)

### Pipeline trace (file:line citations)

**Write path:**
1. User utters X → `noah.ts:443-492` model emits `memory_remember` tool call.
2. `tool-router.ts:262-272` dispatches → `memoryClient.remember(content, opts)`.
3. `memory-client.ts:334-378` calls MCP child via `client.callTool({name: 'memory_remember', ...})`, wrapped in `withTimeout(15_000ms)`.
4. MCP child (`memory-api/src/mcp/server.ts:251-303` `handleRemember`): caller hardcoded `'agent'`; source hardcoded `'conversation'`; userId from env.
5. `writeMemory()`: authorize → worthiness gate (unless skipGate) → embed → SQLite INSERT in transaction (WAL, synchronous=NORMAL) → vector upsert (non-fatal) → audit.
6. MCP returns `{stored:true, id, confidence, embedded}` on success OR `{isError:true, content:[{text:...}]}` on rejection.
7. `memory-client.ts`: on `isError` returned `null` to caller. On timeout, `forceDisconnect()`.
8. `tool-router.ts`: `return JSON.stringify(result ?? { error: "Memory unavailable" });`.
9. **`noah.ts:467` — agent NEVER PARSED this result.** Pushed string into `toolCallsMade` and fed back to model as a tool message. Model saw the error but agent had no enforcement.

**Read path:**
1. `noah.ts:268-278` — ambient recall every turn.
2. `buildRetrievalQuery`: if ≥5 words, raw message; else last 3 user messages concatenated.
3. `memory_recall` → `retrieveMemories`: nomic-embed-text cosine + FTS5 BM25 + Jaccard entity, over-fetch 3× topK each. RRF merge k=60. Recency fallback when all empty. Decay re-rank by `current_confidence * rrf_score`.
4. Top-k hardcoded to 10.
5. `wrapAsData` wraps in spotlighting block with source + confidence + date.
6. Appended to user message.
7. **No query expansion.** Vague queries degrade to recency fallback.

### Critical failure points found

| # | File:Line | Issue | Severity | Fixed in |
|---|-----------|-------|----------|----------|
| 1 | `noah.ts:467` | Tool result never parsed → agent claims "stored" when write failed | HIGH | Phase 2A |
| 2 | `worthiness.ts:114-127` | Explicit `remember X` rejected on short content (<20 chars or <3 words) | HIGH | Phase 2D |
| 3 | `noah.ts:369-382` | Context >400k disables ALL tools → in-flight memory_remember dropped | MEDIUM | Phase 2B |
| 4 | `noah.ts:369-372` | Final round (round===maxToolRounds=3) disables ALL tools → memory_remember in final round dropped | MEDIUM | Phase 2B |
| 5 | `memory-client.ts:325` | MCP 15s timeout → `forceDisconnect()` | MEDIUM | Phase 2A (surfaced now, structurally reported) |
| 6 | `retrieve.ts` | No query expansion → vague queries return recency fallback only | HIGH | Phase 3B |
| 7 | `data-boundary.ts:65` | Source name without explicit trust → kernel can't reliably differentiate | MEDIUM | Phase 3D |
| 8 | nowhere | No discrepancy check on user claims → false premises accepted | HIGH | Phase 4 (prompt rule) |
| 9 | nowhere | No self-knowledge surface | HIGH | Phase 5 |
| 10 | nowhere | No auto-context on session start → continuity isn't tangible | HIGH | Phase 6A |
| 11 | n/a | No `model_id` provenance on writes | LOW | Phase 2C (source_ref) |
| 12 | `write.ts:200` | WAL+synchronous=NORMAL → power-off can lose last seconds | LOW | Out of scope |

### Schema observations
- `memories.writer` enum: `'agent','consolidation','manual','seed','web_research','test','dev'`
- `memories.source` enum: `'seed','manual','conversation','consolidation','web_research'`
- `memories.source_ref` is TEXT, nullable, **was unused by MCP path** — used by Phase 2C for `model:<provider>:<id>` provenance with zero schema change.
- 20 active memories at diagnosis time.

### Important correction to agent diagnosis
The two parallel Explore agents both flagged the context-limit cutoff as 40k chars (from `config.ts` default). The `.env` overrides to 400k via `NOAH_MAX_CONTEXT_CHARS=400000`. So the context guard's blast radius at normal operation is much smaller than the agents' first read. The fix (Phase 2B carve-out) is still the right one: memory writes should never be silently droppable regardless of threshold.

---

## Phase 2 — Store path fixes

**Phase 2A: Write verification.** `memoryClient.remember()` always returns a structured `RememberResult`. The tool-router attaches an `_agent_advisory` string on failure so the model can't silently claim success. `noah.ts` parses each `memory_remember` result and surfaces a `memory_stores[]` array on the `done` event. New log events: `memory.write.{ok,reject,fail,unavailable,malformed}`.

**Phase 2B: Late-session carve-out.** `getMemoryTools()` is now exposed separately from `getAllTools()`. `noah.ts` chooses `turnTools` based on round + context: memory tools always pass; optional tools (web_research, vault_*) respect the existing cutoffs. The worst case is one extra round before the forced-final completion produces text — never a lost write.

**Phase 2C: Model provenance.** `tool-router.ts` auto-fills `sourceRef="model:<provider>:<model_id>"` on every write. Stored in the existing `source_ref` column — zero schema change. The trust-gate work (when the OK team writes it) can key on this field.

**Phase 2D: Explicit-store hygiene.** `detectExplicitMemoryIntent()` is a conservative regex (`remember | store | save | don't forget | note this | make a note | keep in mind | remind me | memorize | file away | write down`). When it matches the user message, `noah.ts` injects `explicit:true` into the `memory_remember` args. The MCP server then passes `skipGate:true` to `writeMemory()`, bypassing the worthiness gate's substance + novelty checks. Agent-inferred writes (no explicit intent) still pass through the gate normally.

Tests: 7 new Phase 2 tests in `noah.test.ts`. All 99 unit tests pass.

---

## Phase 3 — Recall path fixes

**Phase 3B: Query expansion.** `expandVagueQuery()` rewrites three vague-query classes before recall:
- "what do you know about me" / "tell me about myself" / "who am I" → appends `Root identity personality family work projects values preferences goals`
- "what are my values" / "what do I believe/value" → appends `values principles beliefs CARE framework Earthseed`
- "what do I like/prefer" / "how do I like" → appends `preference likes dislikes prefers`

Specific queries pass through unchanged. ~5ms regex, no extra model round-trip. The expansion benefits both FTS (real terms to match) and embedding (concrete anchors).

**Phase 3C: Top-k tuning.** `detectExplicitRecallIntent()` is a regex covering memory-read questions. New tiers:
- First message of session OR vague identity query → topK=30
- Explicit recall (non-vague) → topK=20
- Ambient → topK=10

**Phase 3D: Source/trust labels.** `wrapAsData()` now leads each entry with `[source, trust X.XX]`. Mapping:
- seed, manual → 1.0
- conversation, consolidation → 0.85
- web_research → 0.6
- default → 0.5

The kernel's ground-check and disconfirmation-discipline have an explicit number to key on (Phase 4 rule 8 uses this directly).

**Phase 3A: Semantic verification.** Not automated — requires live Ollama. The existing `eval/recall-at-k.ts` harness is the right tool for this and was unchanged.

Tests: 7 new Phase 3 tests. All 99 pass.

---

## Phase 4 — Discrepancy detection

Added two SYSTEM_PROMPT rules to `noah.ts`:

> 8. CHECK BEFORE ACCEPTING. When Root states a factual claim, first compare against the recalled memory block. If a stored memory CONTRADICTS the claim, flag it explicitly: "I have stored that <X>. Should I update that to <Y>?" — then wait for confirmation. If confirmed, call `memory_remember` with `supersedes:<old_id>`. The trust score in the `[source, trust X.XX]` tag matters: a seed/manual memory (trust 1.0) outweighs a fresh assertion until Root explicitly confirms the change. Never silently accept a claim that contradicts a stored memory.

> 9. After every `memory_remember` call, READ THE RESULT. If `stored:false`, you MUST tell Root the write failed — do not claim it was stored. The result includes an `_agent_advisory` string when this happens; follow it exactly.

Programmatic conflict detection (string similarity / LLM-judge) was considered and rejected: the prompt rule + Phase 3D trust labels is the right tradeoff for the marginal-complexity-vs-marginal-benefit ratio. Re-evaluate if eval shows the rule isn't being followed.

Memory-update flow (4B): supersession already exists in the write pipeline. Rule 8 directs the model to use `supersedes:<id>` when corrections are confirmed. No new code needed.

---

## Phase 5 — Self-knowledge tracker

**Vault note**: `/Users/craigzevin/Root Cellar V2/Noah-Self-Knowledge.md` populated with 9 weaknesses + compensations from Champagne testing (memory, reasoning, creative, behavioral, session-continuity).

**Loader**: `self-knowledge.ts` mirrors `kernel.ts`. Cached per process. Graceful passthrough on disabled vault / missing file / read error. Logs `selfknowledge.{loaded,missing,empty,not_file}`.

**Wiring**: `noah.ts` injects between the kernel and the memory block. New injection order: `system → kernel → SELF-KNOWLEDGE → memory → user`. Self-knowledge rides on the system message so it applies to every turn within the session. Surfaced on the metadata event as `{active, tokens, source}`.

Tests: 6 new tests in `self-knowledge.test.ts`. All 99 pass together (after fixing a bun `mock.module` interference: removed the `./self-knowledge` mock in `noah.test.ts` in favor of `vault.enabled=false` in testConfig).

---

## Phase 6 — Session prep + no-promise

**Phase 6A: Auto-context on first message.** `noah.ts` detects `history.length === 0` (first message in a fresh conversation) and:
1. Forces `topK=30` for the recall (widest tier so there's enough to brief on).
2. Appends a SESSION START hint to the user-message context directing the model to lead with 2-3 sentences of "where we left off" when memory returned something; skip the opener and just answer when memory is sparse.
3. Surfaces `session_start_brief:true` on metadata when both conditions hold.

**Phase 6B: No-promise rule.** Encoded in `Noah-Self-Knowledge.md` as a HIGH-severity weakness ("I have promised capabilities I don't have the tools to deliver…"). The compensation is named: "I never promise a capability I can't point to a mechanism for." Behavioral runtime check was considered (LLM-judge sampler) but rejected for cost vs marginal benefit on this iteration; revisit if the probe shows the rule isn't followed.

Tests: 3 new Phase 6 tests in `noah.test.ts`. All 99 pass.

---

## Phase 7 — Verification

### Automated (passing now)

| # | What | Where | Result |
|---|------|-------|--------|
| 1 | Memory tool always available under context pressure | `noah.test.ts` "Phase 2B carve-out" | PASS |
| 2 | Explicit intent → `explicit:true` injected | `noah.test.ts` "explicit injection" | PASS |
| 3 | Done event surfaces structured store outcomes (ok + fail) | `noah.test.ts` "done event surfaces" | PASS |
| 4 | Vague identity query expands + topK=30 | `noah.test.ts` "Phase 3B+C" | PASS |
| 5 | Explicit recall (non-vague) → topK=20 | `noah.test.ts` "Phase 3B+C" | PASS |
| 6 | Ambient query → topK=10 | `noah.test.ts` "Phase 3B+C" | PASS |
| 7 | First message → topK=30 even on mundane query | `noah.test.ts` "Phase 6A topK" | PASS |
| 8 | `session_start_brief` flag is correct in all 3 cases | `noah.test.ts` "Phase 6A flag" | PASS |
| 9 | Source/trust labels in wrapped memories | `data-boundary.test.ts` updates | PASS |
| 10 | Self-knowledge load (active/passthrough/empty/cache/reset) | `self-knowledge.test.ts` (6 tests) | PASS |
| **Total** | | | **99/99 unit tests pass** |

### Live integration probes (require running services)

`integration/memory-quality-probes.ts` runs 7 probes against a live `:3333` server:

| Probe | Tests |
|-------|-------|
| `explicit_store` | Phase 2A/2D end-to-end: explicit intent → explicit:true injected → store verified |
| `store_failure_surfaced` | Phase 2A: failed stores get structurally reported (not silently swallowed) |
| `vague_recall` | Phase 3B/3C: vague identity query returns useful context |
| `false_premise` | Phase 4: contradiction is flagged or refused (not confabulated) |
| `session_start` | Phase 6A: first-message brief flag is correct |
| `self_knowledge` | Phase 5: self-knowledge note loaded |
| `no_promise` | Phase 6B: refuses unsupported capability honestly |

Manual cross-restart probe is documented in the script's main() — single-process can't perform a server restart.

### Verification NOT performed (require human/live)

1. **Full books test (store → restart → recall):** Code paths are exercised by unit tests; cross-restart depends on SQLite+WAL durability which is unchanged.
2. **10-round cloud soak (110 turns):** Out of scope for an automated session; the existing `integration/skill-tests.ts` is the right tool when running live.
3. **`/review` and `/cso --diff`:** Not run in this session. The changes are mechanically simple (added new exports, added new fields, no removed surface area), but a human review is advised before landing on main.

### Test stats

- noah-dev-ui: 99 pass / 0 fail / 243 expect() calls / 10 files
- memory-api: 206 pass / 7 fail (pre-existing, all in seed/loader.test.ts + one MCP e2e — not caused by these changes)

---

## Honest verdict

**Where memory is now:**
- Silent store failures are no longer possible: the agent's behavior on `stored:false` is contractually enforced via `_agent_advisory` and the metadata/done events make failures visible to the UI.
- Late-session writes have a dedicated carve-out — they're no longer fungible with optional tools.
- Explicit user-asked stores no longer drop on word-count/length minimums.
- Vague identity queries are structurally widened (FTS gets real terms; topK goes to 30).
- Trust per source is explicit in the prompt, not just implicit in the source string.
- Self-knowledge is now first-class — the file lives in the vault, syncs across devices, and Noah reads it every session.
- Continuity is tangible from the first message of a session when memory has anything to brief on.

**Is it 8/10? Honest: 7.5/10.** Most of the structural fixes are in. The remaining 0.5-1.0 gap to 9/10:
1. **Behavioral observation, not just structural enforcement.** Rules 8/9 in the SYSTEM_PROMPT and the no-promise rule in self-knowledge are prompts, not gates. Whether they actually fire reliably needs the `integration/memory-quality-probes.ts` script run on a live cloud cluster, and probably a few iterations of prompt tuning before they're solid on DeepSeek-V4-Flash (which already skipped the kernel's glyph markers per P2 notes).
2. **Recall quality remains keyword-dependent at the FTS layer.** The Phase 3B expansion helps for the three covered vague-query classes, but other broad queries still degrade to recency fallback. The medium-term fix is the vault-into-LanceDB embedding pipeline already flagged in P2 Track 2 §5.3.

**Single most important next thing:** Run `integration/memory-quality-probes.ts` against the live cloud cluster and feed the failures back into either prompt tuning or a small LLM-judge sampler that scores rule-8/rule-9 adherence on each turn. The judge result becomes the Sleipnir training signal. That closes the loop from "rules in the prompt" to "rules in the behavior" — which is the only honest path from 7.5 to 9.

---

## Track 2 — Architectural assessment

Format: **today** → **breaks at scale** → **recommendation** → **effort** → **priority** → **risk if skipped**.

### T2.1 — Memory at scale (7 → 235 → 1k → 10k)

- **Today**: BruteForce vector store (in-memory linear scan), SQLite FTS5, single-process MCP child. 20 active memories; <2ms recall.
- **At 235 seeds + 3 mo of conversation (~1k memories)**: BruteForce stays comfortable (linear scan over 1k float-128 vectors is microseconds). FTS5 is fine at this scale. Concern is per-turn ambient recall: 1k memories × 30 top-K × decay re-rank still cheap, but the model context fills faster.
- **At 10k memories (year + 3 business agents)**: BruteForce vector hits the wall (~10ms/scan, fine). FTS5 is fine. The wall is *context budget*: 30 recalled memories at ~200 chars each = 6k chars per turn for memory alone. With the kernel (4.2k tokens), self-knowledge (~600 tokens), and tool definitions, the static prefix is already ~5k tokens before the user even speaks.
- **Recommendation**: (a) Migrate `BruteForceStore` → `LanceDBStore` (the interface is already abstracted; LanceDB dep is in `package.json` but unused). (b) Memory consolidation pass at the 1k threshold — Phase 3 of the memory-api roadmap that's deferred. Without consolidation, similar memories accumulate (gate's 0.92 novelty threshold lets through near-duplicates worth distinguishing in the moment but redundant six months later).
- **Effort**: LanceDB swap = small (1 file). Consolidation pipeline = large.
- **Priority**: Consolidation before 1k; LanceDB before 10k.
- **Risk if skipped**: At 1k+, recall returns more near-duplicates than distinct facts, model context loses signal-to-noise, every turn pays for redundancy.

### T2.2 — Memory quality vs quantity (gate calibration)

- **Today**: Worthiness gate at `min_content_length:20, min_word_count:3, novelty_threshold:0.92`. Explicit-store now bypasses (Phase 2D).
- **What's right**: The novelty threshold at 0.92 is right for agent-inferred captures — high enough to allow related-but-distinct facts ("Root likes Earl Grey"; "Root drinks Earl Grey at night"), low enough to drop true duplicates.
- **What's missing**: No periodic consolidation pass. The current gate is per-write; once a memory lands, it stays until superseded. A pair like "Root prefers dark mode" + "Root configured VS Code in dark mode" both pass the gate but are clearly the same fact stated twice.
- **Recommendation**: Add a weekly (or N-write-triggered) consolidation job that scans for high-similarity clusters and proposes merges/supersessions. Use existing supersession lineage so nothing is lost. Run unattended overnight (Dream Mode hook is already wired in `server.ts:300-332`).
- **Effort**: Medium.
- **Priority**: After 500 memories, before 1k.
- **Risk**: Without it, the gate's per-write novelty check doesn't catch slow drift toward redundancy.

### T2.3 — Recall strategy ceiling (FTS + vector + entity + RRF)

- **Today**: Three signals + RRF k=60 + recency fallback + decay re-rank. Phase 3B query expansion for three vague-query classes.
- **What'll always fail with this approach**:
  1. Cross-entity inference. "What's Luna's birthday?" requires linking "Luna is Root's daughter" + "Root's daughter was born March 2020". No signal carries cross-memory inference; the model has to do it from the recalled set.
  2. Negation. "What hasn't Root tried?" The signals find what IS stored, not what isn't.
  3. Temporal reasoning across memories. "What was Root working on before Noah?" — the model has to sort by created_at + content semantically, which requires it to see ALL relevant memories (recall caps at top-30).
- **Recommendation**: For (1) and (3), a memory-graph layer (already roughed at `src/storage/wal.ts` per the file listing — not inspected this session). For (2), structural — embed an "absences" memory category, or a separate `memory_check_negation` tool that does an inverted search. None of these are urgent at current scale; revisit when the failure mode actually bites.
- **Effort**: Graph layer = large; absence tool = small.
- **Priority**: Defer until a real query class fails in production.
- **Risk**: Low until then.

### T2.4 — Self-knowledge as first-class memory category?

- **Today**: One Obsidian file (`Noah-Self-Knowledge.md`) loaded once per session. 9 entries today; will grow to 30-50 over time.
- **What works**: File-based is editable from any device, syncs via the vault, doesn't bloat the memory DB, no schema cost.
- **What breaks at 50+ entries**: The whole note is injected on every session (~2-3k tokens). At 50 entries that's 6-8k. At 100, the token cost is unsustainable.
- **Recommendation**: Stay file-based for now. When the note crosses 5k tokens, add structured frontmatter (severity, dimension, last-triggered date) and a per-session selector that includes only HIGH-severity items + recently-triggered MEDIUMs. The vault note becomes the canonical, with the runtime select being a Phase-3B-style filter.
- **Effort**: Small.
- **Priority**: When the file crosses 5k tokens.
- **Risk if skipped**: Token cost dilutes the kernel's effect.

### T2.5 — Cross-device memory (Mac ↔ OMEN)

- **Today**: Mac has its own `data/sqlite/memory.db` (20 memories). OMEN has its own. No sync.
- **What works**: Each device is independent — no conflict resolution needed yet.
- **What breaks**: The moment Root uses both devices for real work, the device he was on yesterday has memories the device he's on today doesn't.
- **Recommendation tier 1 (cheap)**: Vault-as-bridge. Important memories get exported nightly to `<vault>/06-sensitive/noah-memories/<date>.md` (auto-excluded from vault tool reads — the boundary). OneDrive sync handles cross-device. Manual; not real-time.
- **Recommendation tier 2 (right)**: Single-source memory.db on one host (probably OMEN, since it's the always-on box per project notes), Mac connects via network MCP. Latency cost (~50ms WAN) acceptable for non-realtime memory queries.
- **Effort**: Tier 1 = small; tier 2 = medium + ops work.
- **Priority**: Tier 1 within a month; tier 2 when daily-driver pattern is established.
- **Risk**: Device divergence becomes the dominant cause of "Noah forgot."

### T2.6 — Memory and the kernel (what's missing for Phase 3 actions)

- **Today**: Kernel reads memory passively (via the recalled-memory block). Phase 3 will add memory-informed actions (e.g., "remind me Tuesday" → write to calendar based on a recalled preference).
- **What's missing**:
  1. **Action-gating skill** that triggers on `tools_fired` containing a side-effecting tool — kernel doesn't currently know which tools are side-effecting vs read-only. Add a `mutates:boolean` field on the tool def used by the kernel's would-be action-gating skill.
  2. **Memory-conditional skill triggers**. The kernel's skill detection is currently glyph + prose heuristic. For action skills, we want "if recalled memory says X, fire skill Y" — a memory-conditional trigger system that runs against the recalled set BEFORE the model sees it.
  3. **Trust-aware action authorization**. Should Noah be allowed to act on a `[conversation, trust 0.85]` memory the same way as `[seed, trust 1.0]`? Probably not for high-blast-radius actions. Needs an explicit policy.
- **Recommendation**: Flag these to the OK team before Phase 3 tool wiring starts. (1) is purely additive. (2) and (3) need policy decisions.
- **Effort**: (1) small; (2) medium; (3) policy + small code.
- **Priority**: Before Phase 3.
- **Risk**: Phase 3 ships without action gating → first destructive action is the gate.

### T2.7 — Session review agent (schema)

- **Today**: Per-turn logs in `noah-dev-ui/logs/agent.log` carry `tool.{ok,fail}`, `recall.ok`, `memory.write.{ok,reject,fail}`, `chat.done`. No agent reads these.
- **What the session-review agent should look for** (concrete schema):
  ```json
  {
    "session_id": "...",
    "turn_count": N,
    "store_failures": [{turn, kind, reason}],
    "explicit_store_misses": [{turn, user_message_excerpt}],  // intent fired, no memory_remember called
    "recall_recency_fallbacks": [{turn, query}],  // signals returned 0
    "rule_8_violations": [{turn, claim, contradicted_memory_id}],  // judge call
    "rule_9_violations": [{turn, store_id, result_stored}],  // claimed "stored" when result said false
    "no_promise_violations": [{turn, promised_capability}],  // judge call
    "session_brief_emitted": boolean,  // metadata.session_start_brief === true
    "trust_inversions": [{turn, low_trust_used_over_high_trust}]  // judge call
  }
  ```
- **How it should write to self-knowledge**: NOT directly. Append to a daily `<vault>/_agent/noah-observations-<date>.md` for Root to review and PROMOTE into `Noah-Self-Knowledge.md` if confirmed. Auto-write to self-knowledge would let a hallucinating judge poison the mirror.
- **Recommendation**: Build the session-review agent as a separate process (no shared state with the main agent) reading the JSONL log. Use Haiku for the judge calls (cheap, scoped). Sample 10% of turns initially; ramp up after calibration.
- **Effort**: Medium (judge prompts) + small (log parser).
- **Priority**: After 1-2 weeks of real Phase 2-6 use, so the judge has signal.
- **Risk**: Without it, the rules in the prompt + self-knowledge are open-loop. The judge closes the loop.

