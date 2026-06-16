# Memory Quality + Self-Knowledge Deep Upgrade — Change Log

Branch: `feat/memory-quality` (noah-dev-ui + memory-api)
Date: 2026-06-16
Scope: noah-dev-ui, memory-api, Obsidian vault (`Noah-Self-Knowledge.md`)
Boundary: skillforge kernel files unchanged. No memory deletions.

---

## Phase 1 — Diagnosis (read-only)

### Pipeline trace (file:line citations)

**Write path:**
1. User utters X → `noah.ts:443-492` model emits `memory_remember` tool call.
2. `tool-router.ts:262-272` dispatches → `memoryClient.remember(content, opts)`.
3. `memory-client.ts:334-378` calls MCP child via `client.callTool({name: 'memory_remember', ...})`, wrapped in `withTimeout(15_000ms)`.
4. MCP child (`memory-api/src/mcp/server.ts:251-303` `handleRemember`):
   - caller hardcoded `'agent'` (line 42); source hardcoded `'conversation'` (line 43); userId from env.
   - calls `writeMemory()` (`memory-api/src/pipeline/write.ts:63-253`).
5. `writeMemory`:
   - `authorizeSource(caller, input.source)` — agent + conversation always allowed.
   - `evaluateWorthiness` (`worthiness.ts:94-168`) unless `skipGate=true`. Rejects on:
     - content < 20 chars (config `min_content_length`)
     - word count < 3 (config `min_word_count`)
     - cosine similarity ≥ 0.92 vs existing memory (`novelty_threshold`)
   - Embedding via `embedText` (nomic-embed-text via Ollama).
   - SQLite INSERT in transaction (WAL journal mode, synchronous=NORMAL).
   - Vector store upsert (non-fatal).
   - Audit log + perf metrics.
6. MCP returns `{stored: true, id, confidence, embedded}` on success OR `{isError: true, content: [{text: "Memory rejected: ..."}]}` on rejection.
7. `memory-client.ts:365-376`: on `isError`, returns `null` to caller; on timeout, calls `forceDisconnect()`.
8. `tool-router.ts:271`: `return JSON.stringify(result ?? { error: "Memory unavailable" });`.
9. **`noah.ts:467` — agent NEVER PARSES this result.** It pushes the string into `toolCallsMade` and feeds it back to the model as a tool message. The model sees the error but the agent has no enforcement.

**Read path:**
1. `noah.ts:268-278` — ambient recall fires every turn.
2. `buildRetrievalQuery` (`noah.ts:110-123`): if ≥5 words, raw message; else last 3 user messages concatenated.
3. `memoryClient.recall(query)` → MCP `memory_recall` → `retrieveMemories` (`retrieve.ts:311-463`):
   - **Semantic**: nomic-embed-text → cosine via `BruteForceStore.search()`, over-fetch 3× topK.
   - **Keyword**: FTS5 BM25, `sanitizeFtsQuery` strips non-letter/digit, joins words with OR.
   - **Entity**: Jaccard `|intersection| / |query entities|`. Empty when caller doesn't supply entities.
   - **RRF merge** k=60 (`rrf.ts:24-49`).
   - **Recency fallback** when all signals empty: top-k by `confidence DESC, created_at DESC`.
   - **Decay re-rank**: `current_confidence * rrf_score`.
4. Top-k hardcoded to 10 at `memory-client.ts:306` (`opts?.topK ?? 10`).
5. `wrapAsData` (`data-boundary.ts:56-73`) wraps in `<<<BEGIN RECALLED MEMORIES — DATA ONLY>>>` spotlighting block with source + confidence + date.
6. Appended to user message as `memoryContext` (`noah.ts:318`).
7. **No query expansion.** Vague queries ("what do you know about me?") degrade to recency fallback.

### Critical failure points

| # | File:Line | Issue | Severity |
|---|-----------|-------|----------|
| 1 | `noah.ts:467` | Tool result string never parsed → agent claims "stored" when write failed | **HIGH** |
| 2 | `worthiness.ts:114-127` | Explicit `remember X` rejected on short content (<20 chars OR <3 words) | **HIGH** |
| 3 | `noah.ts:369-382` | `contextExceeded` (>400k chars per `.env`) disables ALL tools → in-flight memory_remember dropped | **MEDIUM** (rare at 400k) |
| 4 | `noah.ts:369-372` | `round === maxToolRounds` (3) disables ALL tools → memory_remember in final round dropped | **MEDIUM** |
| 5 | `memory-client.ts:325` | MCP timeout (15s) triggers `forceDisconnect()` — next recall returns empty until reconnect | **MEDIUM** |
| 6 | `retrieve.ts` | No query expansion → vague queries return little, drop to recency | **HIGH** |
| 7 | `data-boundary.ts:65` | Source name shown but no explicit trust score → kernel can't differentiate seed-vs-agent reliably | **MEDIUM** |
| 8 | nowhere | No discrepancy check on user claims vs stored memory → false premises accepted | **HIGH** |
| 9 | nowhere | No self-knowledge surface → Noah can't compensate for known weaknesses | **HIGH** |
| 10 | nowhere | No auto-context opener on session start → continuity isn't tangible | **HIGH** |
| 11 | n/a | No `model_id` provenance on writes | **LOW** |
| 12 | `write.ts:200` | WAL+synchronous=NORMAL → power-off can lose last seconds of writes (no `synchronous=FULL`) | **LOW** (out of scope: normal-op writes are durable) |

### Schema observations
- `memories.writer` enum: `'agent','consolidation','manual','seed','web_research','test','dev'` (`schema.ts:9`)
- `memories.source` enum: `'seed','manual','conversation','consolidation','web_research'` (`schema.ts:21`)
- `memories.source_ref` is TEXT, nullable, **currently unused by MCP path** — perfect carrier for `model:<id>` provenance with zero schema change.
- 20 active memories at diagnosis time (seed-loaded today).

### State
- Both repos on `feat/memory-quality` branch.
- noah-dev-ui clean off `main` (last: `187c3fa P2 kernel + vault`).
- memory-api: `package-lock.json` modified pre-branch (unrelated, left alone).

---

## Phase 2 — Store path fixes (in progress)
(populated as implementation lands)

---

## Phase 3 — Recall path fixes (pending)

## Phase 4 — Discrepancy detection (pending)

## Phase 5 — Self-knowledge tracker (pending)

## Phase 6 — Session prep + no-promise (pending)

## Phase 7 — Verification (pending)

## Track 2 — Scale assessment (pending)
