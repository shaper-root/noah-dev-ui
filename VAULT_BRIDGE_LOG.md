# Vault Bridge — Change Log

Branch: `feat/vault-bridge` (noah-dev-ui only — memory-api unchanged).
Date: 2026-06-16
Scope: cross-device memory sync, session summaries, daily observations.
Boundary: writes only to `_noah/` subdirectory; no vault deletes; no auto-write to `Noah-Self-Knowledge.md`.

---

## Files touched

| File | Change |
|------|--------|
| `vault.ts` | + `writeNote` / `appendToNote` with hard `_noah/` jail (the security boundary). Path validation: lexical (`..` segments + absolute + Shannon block) + resolved-absolute prefix re-check + `.md`/`.json` only + 256KB per-write cap. Every write logs `vault.write.{ok,fail,denied}` with kind. No path that doesn't start with `_noah/` can be written, ever. |
| `vault.test.ts` | + 12 tests for the write surface (jail, traversal, overwrite, oversize, extension, createDirs, etc.). |
| `vault-bridge.ts` | NEW. The orchestrator: memory export (incremental + reconciliation), memory import (with manifest dedup + recall-based exact-match check), session summaries (DB-backed, model-generated), daily observations (structured logs from DB metadata). |
| `vault-bridge.test.ts` | NEW. 18 tests covering export round-trip, import dedup, manifest persistence, observation append, summary readback, guardrails. |
| `config.ts` | + `vaultBridge: { enabled, deviceId }`. Device ID defaults: `mac` on Darwin, `omen` on Win32, hostname-based on Linux. `NOAH_DEVICE_ID` env overrides. |
| `noah.ts` | + incremental memory export hook (after each successful `memory_remember`, fire `exportMemoryIncremental` — wrapped in try/catch so vault failures never break the turn). + first-message session block now includes recent vault session summaries alongside memory recall for richer cross-device continuity. |
| `noah.test.ts` | + `vaultBridge` and `memory` keys in testConfig so the real vault-bridge module no-ops cleanly under tests. |
| `server.ts` | + startup reconciliation (export-catchup + import + summaries + observations; first two sync, last two background after port binding). + SIGTERM/SIGINT hook for best-effort summary on graceful shutdown (10s cap). |

---

## Directory structure created in vault

```
RootCellar2/_noah/
├── _manifest.json                    ← high-water marks + imported file tracker
├── memories/                         ← one file per day per device
│   ├── 2026-06-16_mac.md
│   └── 2026-06-17_mac.md
├── sessions/                         ← one file per conversation
│   ├── 2026-06-16_mac_1.md
│   ├── 2026-06-16_mac_2.md
│   └── ... (one per conversation, numbered per device per day)
└── observations/                     ← one file per day, appended across sessions
    └── 2026-06-16.md
```

The `_noah/` prefix means it sorts at the bottom of Obsidian's file list (underscore convention) — clearly machine-generated, visually separated from Root's notes.

---

## Sample artifacts (from the live system)

### Memory export (`_noah/memories/2026-06-17_mac.md`)

```markdown
---
device: mac
session_date: 2026-06-17T00:00:00Z
exported_at: 2026-06-17T01:43:55.892Z
memory_count: 3
---

## Memories exported from mac session (2026-06-17)

### mem_2137761b-8ae2-4ec8-a80a-366ba4772490
- **content:** The four books on Root's desk are: Earthseed (Octavia Butler), I Have No Mouth and I Must Scream (Harlan Ellison), The Fire Next Time (James Baldwin), and Beautiful Math (Chris Bernhardt).
- **type:** fact
- **source:** conversation
- **trust:** 0.85
- **source_ref:** model:cloud:accounts/fireworks/models/deepseek-v4-flash
- **created_at:** 2026-06-17 00:54:33

### mem_1379e5f0-e447-49d8-9272-70acba08a5a9
- **content:** Root's favorite color is teal.
- **type:** preference
- **source:** conversation
- **trust:** 0.85
- **source_ref:** model:cloud:accounts/fireworks/models/deepseek-v4-flash
- **created_at:** 2026-06-17T01:43:55.892Z
```

YAML frontmatter is machine-parseable; the bullet-list body is human-readable. Memory IDs are preserved so re-imports dedupe.

### Session summary (`_noah/sessions/2026-06-16_mac_1.md`)

```markdown
---
device: mac
conversation_id: 9f11e3a2-41a2-4d5c-b3ae-7e21d1abc20b
session_date: 2026-06-16
session_number: 1
turn_count: 1
duration_estimate_min: 0
memories_stored: 0
memories_failed: 0
model: (unknown)
kernel: v1.2.0
---

## Session Summary — mac, 2026-06-16 (#1)

### What we discussed
The user asked Noah to recall their current testing setup from memory alone. Noah could only reference a single data point from the current session—that testing was happening on a Mac—and noted no broader details were stored.

### Key decisions
(none this session)

### Memories stored
(none this session)

### Memories that failed to store
(none this session)

### Open items / follow-ups
- If you want Noah to remember details about your testing setup, provide them explicitly during the conversation.

### Root's emotional state / energy
Matter-of-fact and efficient; the user sought a clear memory check without vault access, and Noah responded directly without frustration or excitement.
```

Generated by the cloud model on startup reconciliation. Instructed to summarize at the topic/decision level — NOT verbatim — and to refuse to include API keys, paths, or other sensitive details.

### Daily observations (`_noah/observations/2026-06-16.md`)

```markdown
---
date: 2026-06-16
device: mac
---


# Observations — 2026-06-16 (mac)

_Auto-generated. Root promotes confirmed patterns to Noah-Self-Knowledge.md._

## Session ba3e8c92 (mac, 23:08)

### Store outcomes
- 0 attempted, 0 succeeded, 0 failed (0/0 success rate)

### Recall quality
- 1 recall queries this session
- 0 vague queries (Phase 3B expansion applied)
- 0 empty results (recency fallback)

### Behavioral notes
- Session prep fired on first message: no
- Self-knowledge active: no

***

## Session 9f11e3a2 (mac, 21:39)
...
```

Auto-written from structured metadata in `rootworks.db`. Per the T2.7 design from the memory-quality phase, this NEVER auto-writes to `Noah-Self-Knowledge.md` — Root reviews and promotes confirmed patterns.

### Manifest (`_noah/_manifest.json`)

```json
{
  "lastExportedAt": "2026-06-17T01:43:55.892Z",
  "imported": {
    "_noah/memories/2026-06-17_omen.md": {
      "importedAt": "2026-06-17T01:46:44.867Z",
      "ids": ["omen-test-12345"]
    }
  }
}
```

Tracks the high-water mark for export reconciliation + which other-device files have been imported (and which memory IDs from each).

---

## Test results (all 9 from the brief)

| # | Test | Result | Evidence |
|---|------|--------|----------|
| 1 | Memory export — store a fact, verify it appears in `_noah/memories/` with correct format | **PASS** | Live: "Remember teal" → `mem_1379e5f0...` in `2026-06-17_mac.md` |
| 2 | Memory import — create fake omen export, restart, verify imported | **PASS** | Live: simulated `_noah/memories/2026-06-17_omen.md` → `Import: 1 stored` + memory in SQLite with `source_ref=vault-sync:omen:...` |
| 3 | Deduplication — import same memory twice | **PASS** | Live: 2nd restart → `Import: 0 stored, 1 duplicates` via manifest |
| 4 | Session summary — have a conversation, verify summary appears | **PASS** | Live: 6 summaries generated for existing conversations on startup |
| 5 | Observations — verify observations are written | **PASS** | Live: `_noah/observations/2026-06-16.md` with structured entries |
| 6 | Cross-device simulation — change device ID, import, verify accessible | **PASS** | Live: "Where is my office printer?" → Noah recalled the omen-imported memory |
| 7 | Session prep with summaries — verify Noah references recent summaries on first message | **PASS** | Live: first message metadata `session_start_brief=true`, response: "Evening, Root. Last we spoke I'd been reflecting back..." |
| 8 | Integration journey still passes | **PASS** | 130/130 unit tests including the existing 99 + 18 vault-bridge + 12 vault writes + 1 new |
| 9 | Vault write guardrails — attempt to write outside `_noah/` | **PASS** | Unit tests: every non-`_noah/` path (absolute, `../`, no-prefix, wrong-case) returns `ok:false` |

### Live cross-device verification (the crown jewel test)

1. Stored a fake "omen" device export file with a memory Noah on this Mac had never heard of.
2. Restarted Noah.
3. Startup log: `[vault-bridge] Import: 1 stored, 0 duplicates, 0 failed, 3 files scanned`
4. SQLite verification: `667b8d3c-786e-4495-ae63-c62c239ca7ef | vault-sync:omen:model:cloud:simulated-omen | Root's office printer at home is on the second floor.`
5. Asked Noah: "Where is my office printer?"
6. Noah's response: *"Your home office printer is on the second floor, as I have it. ⚡ Assuming that's still where it lives — I don't have a live connection to track whether it's been moved."*

Cross-device sync verified end-to-end. The forensic trail (`source_ref=vault-sync:omen:...`) means a future session-review agent can distinguish locally-authored memories from cross-device imports.

---

## Assessment: is the vault bridge functional for cross-device use?

**Yes, with the caveats below.**

**What works today (live-verified on this Mac):**
- Every successful memory store is mirrored to the day's vault file within milliseconds.
- Startup reconciliation catches anything the incremental writer missed (crash, sleep, killed process).
- Other-device exports are imported on next startup; manifest prevents re-import.
- Session summaries auto-generate for the most recent 5 unsummarized conversations (cap bounded for boot time).
- Daily observation file builds up per-session stats and feeds the (future) session-review agent.
- First-message session prep now reads recent session summaries alongside memory recall — Noah's continuity opener can reference what happened on the other device.

**Limitations / known gaps:**
1. **Dedup is exact-content only.** Near-duplicate memories from two devices will both land. The worthiness gate's 0.92 novelty threshold catches first-time stores; cross-device imports bypass it (explicit:true), so semantic near-duplicates pass through. Acceptable tradeoff for freshness; revisit if pollution becomes visible.
2. **Summary cap = 5 per startup.** First boot on a Mac with 500 historical conversations will only summarize the 5 most-recent. A backfill script could be added later if needed.
3. **The `session_start_brief` and `self_knowledge_active` flags in observations are hardcoded false** — the SSE metadata isn't persisted into rootworks.db's message metadata, so observations built from the DB don't know whether those fired. A small DB schema addition could fix this; left for the session-review-agent phase.
4. **OMEN side is untested.** Everything in this PR was verified on Mac; the OMEN code path is symmetric (same module, just `device=omen`), but the cross-device handshake hasn't been validated end-to-end with real Obsidian Sync. A real two-device test is the next-most-important verification.
5. **`bun --watch` causes extra reconciliation runs.** Each file save during development triggers a restart, which reruns reconciliation. Harmless (everything is idempotent) but noisy in dev. Production launcher uses `bun run`, not `bun --watch`.

---

## Boundaries honored

- ✅ All vault writes go to `_noah/` (enforced in `vault.ts:safeWritePath` — every non-`_noah/` path returns `kind: "denied_prefix"`)
- ✅ No vault file deletion exposed anywhere in the codebase
- ✅ No memory.db schema changes (import uses existing `memory_remember` MCP)
- ✅ Shannon block applies to writes too (`denied_shannon` kind)
- ✅ Summaries instructed to strip API keys, passwords, private paths
- ✅ Observations auto-write; **Noah-Self-Knowledge.md is human-promoted** (no code path in this PR touches that file)
- ✅ Every write event logged (`vault.write.{ok,fail,denied}` + per-operation events)
