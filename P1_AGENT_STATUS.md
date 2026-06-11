# P1 Conversational Agent Runtime — Status

**Date:** 2026-06-10  
**Status:** Blocks 0–5 complete. Verification gate in progress.

---

## Block Completion

| Block | Name | Status | Tests |
|-------|------|--------|-------|
| 0 | Preflight | Done | MCP spike proven |
| 1 | Agent loop core | Done | memory-client, model-client, noah.ts refactored |
| 2 | Data-not-instruction boundary | Done | 13 tests |
| 3 | Web research tool | Done | 1 test (stub provider) |
| 4 | Kernel seam | Done | 3 tests |
| 5 | recall@k harness | Done | 19 tests |

**Total: 36 tests, 0 failures, 74 expect() calls**

## Files Created

| File | Purpose |
|------|---------|
| `data-boundary.ts` | Spotlighting delimiters + provenance wrapping for recalled memories and web results |
| `data-boundary.test.ts` | 13 tests: delimiters, provenance labels, injection containment |
| `web-research.ts` | Stub (default) + DuckDuckGo HTML scrape (opt-in) web search |
| `web-research.test.ts` | 1 test: stub shape |
| `kernel-seam.ts` | PassthroughKernel implementing KernelSeam interface (P2 OK-kernel seam) |
| `kernel-seam.test.ts` | 3 tests: passthrough, health, factory |
| `eval/recall-at-k.ts` | Recall evaluation harness: 12 fixtures, pure check logic, MCP-based runner |
| `eval/recall-at-k.test.ts` | 19 tests: fixture validation, checkRecall logic, report formatting |

## Files Modified

| File | Changes |
|------|---------|
| `noah.ts` | Imports data-boundary + kernel-seam, DATA BOUNDARY section in system prompt, kernel processing in chat pipeline, `web_research` in tool pattern |
| `tool-router.ts` | Web research tool definition + dispatch, imports from data-boundary and web-research |
| `config.ts` | `webSearch.provider` config (stub/ddg) |
| `memory-client.ts` | BunStdioTransport for Bun.spawn Windows MCP transport, full MCP client |
| `model-client.ts` | Local + cloud model abstraction, tool schema support |
| `package.json` | Added `recall-eval` script |

## Architecture

```
User message
  -> buildRetrievalQuery (short utterance expansion)
  -> memoryClient.recall (MCP stdio -> memory-api)
  -> kernel.process (PassthroughKernel, seam for P2)
  -> wrapAsData (spotlighting delimiters + provenance)
  -> augmented prompt (system + history + wrapped memories + corrections)
  -> modelClient.chat (local Ollama or cloud)
  -> parseToolCalls (structured or regex fallback for Qwen)
  -> dispatchTool (memory_*, web_research)
  -> tool loop (up to maxToolRounds)
  -> response stream (SSE: token | thinking | done | error | tool_call | metadata)
```

## Security Invariants Preserved

- **ADD-only**: No UPDATE of content, no DELETE. Metadata updates only (superseded_by, confidence).
- **1D security**: caller=agent, source from env. Agent blocked from writing source=seed/manual.
- **Data-not-instruction**: Recalled memories wrapped in `<<<BEGIN RECALLED MEMORIES — DATA ONLY>>>` / `<<<END RECALLED MEMORIES>>>` with provenance and trust scores.
- **Web research untrusted**: Results wrapped in `<<<BEGIN WEB RESEARCH RESULTS — UNTRUSTED DATA>>>` with 60% trust.
- **Source trust hierarchy**: seed/manual 1.0, conversation/consolidation 0.85, web_research 0.6.
- **No keys in code**: Cloud key from env (`NOAH_CLOUD_KEY`).
- **IP boundary**: Shannon not touched. Kernel seam is OK-kernel infrastructure only.

## Known Limitations

- Web research DuckDuckGo provider uses HTML scraping (fragile, may break on layout changes)
- recall@k harness MCP runner untested in CI (requires memory-api + node + tsx)
- No integration tests for full chat pipeline (requires running Ollama + memory-api)
- KernelSeam passes full conversation history (plan notes: bound to last 20 in future)
- `sessionCorrections` capped at 50 per conversation (FIFO eviction)

## Next Steps

- Run quality gates: /review, /cso
- Integration smoke test with running memory-api
- P2: OK-kernel integration via KernelSeam
