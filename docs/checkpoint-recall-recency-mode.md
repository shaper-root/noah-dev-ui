# Checkpoint — Memory Recall: Recency Mode for Session-Start (interim)

**Date:** 2026-06-18
**Repos:** `memory-api` (engine) + `noah-dev-ui` (caller)
**Status:** Implemented + verified (engine/unit/integration/caller). Live stack
check is the one remaining manual step (see §6) — it needs Ollama + a live model,
which are not available in this dev environment.

> **THIS IS THE INTERIM TWO-MODE FIX.** It unblocks the session-start intro recall
> ("haven't talked in two days" surfacing stale content-equivalent memories) by
> giving the caller an explicit **recency-weighted** mode for ONE known
> recency-dominant query type. It is **not** the relevance-quality fix and **not**
> dynamic per-query weighting — those (retrieval ranks resemblance, not true
> relevance; the recency/relevance tradeoff is query-dependent rather than a fixed
> knob) are the tracked **Stage 2/3 workstream** and are deliberately untouched here.

---

## 1. What changed (two modes, caller-selected — NOT a global reweight)

A `mode` parameter now flows `noah.ts → memory-client → MCP → retrieveMemories`:

- **`relevance` (default):** byte-for-byte the prior ranking. Every recall that
  existed before — ambient, explicit, vague, model-issued, vault-bridge — is
  unchanged.
- **`recency_weighted`:** the same three relevance signals run and the same RRF
  fusion happens; ONLY the final sort additionally multiplies in a bounded
  recency boost. Selected by exactly one caller: the `noah.ts` first-message
  session-start recap.

Files:

| Repo | File | Change |
|---|---|---|
| memory-api | `config/recency.yaml` | **new** — freshness half-life + floor (separate from `decay.yaml`) |
| memory-api | `src/pipeline/recency.ts` | **new** — `recencyBoost(age, cfg)` + `loadRecencyConfig()` |
| memory-api | `src/pipeline/retrieve.ts` | `mode` added to `RetrieveInputSchema`; final sort branched; audit logs `mode` |
| memory-api | `src/mcp/server.ts` | `handleRecall` accepts host-only `mode` (whitelisted, **not** advertised to the model) |
| noah-dev-ui | `memory-client.ts` | `recall()` opts gains `mode`, threaded into the MCP `callTool` arguments |
| noah-dev-ui | `noah.ts` | first-message recall passes `mode: "recency_weighted"`; all else unchanged |
| memory-api | `tests/pipeline/recency.test.ts` | **new** — boost math/bounds/config (10 tests) |
| memory-api | `tests/pipeline/retrieve.recency.test.ts` | **new** — flip / guard / golden (3 tests) |
| noah-dev-ui | `noah.test.ts` | **new** — caller-wiring tests (first-message vs not) |

---

## 2. The `recencyBoost` function (shape + half-life config)

```
recencyBoost(age_days) = floor + (1 - floor) · exp(-age_days · ln2 / half_life_days)

  boost(0)            = 1.0             fresh — no penalty
  boost(half_life)    = (1 + floor)/2   one half-life — halfway to the floor
  boost(age → ∞)     → floor           ancient — biased down, NEVER zeroed
```

Config — `memory-api/config/recency.yaml` (its OWN file; does **not** reuse, and
is **separate** from, `decay.yaml`'s truth-longevity half-lives):

```yaml
half_life_days: 7     # FRESHNESS in days (short). Tunable up to ~14 for a gentler bias.
floor: 0.5            # bounds the freshest:oldest boost ratio at 2x.
```

**Why it biases without dominating (the core design constraint):**

- The boost is **multiplicative** and **bounded in `[floor, 1]`** (`floor = 0.5` →
  the freshest memory gets at most a **2×** edge over an infinitely old one).
- It **never reaches zero**, so it cannot filter a memory out — a highly-relevant
  old memory (high `rrf_score`, especially multi-signal) still surfaces.
- Concretely, the worst case "fresh-irrelevant vs old-relevant" resolves to
  **old-relevant**: a memory matching 3 signals carries ≈3× the RRF mass of a
  single-signal one; at the **maximum** recency penalty (≈floor) the old memory's
  effective score is `3 × 0.5 = 1.5×` the fresh one's — it still wins. The boost
  **breaks ties and gently biases**; it does not override a clear relevance winner.
- **Half-life = 7 days** is chosen for the acute symptom ("today vs two days ago"):
  it yields ≈10% separation across that 2-day gap, enough to surface today's
  threads over content-equivalent 2-day-old ones, while the long decay half-lives
  (months) leave that gap effectively unranked.

`half_life_days` (and `floor`) are **config, not hardcoded** — loaded via
`loadRecencyConfig()` and cached, mirroring `loadDecayConfig()`.

---

## 3. Final-sort change (recency mode only) + byte-unchanged proof

`retrieve.ts` final re-rank is now branched. The **relevance branch is the
original four lines verbatim**:

```ts
if (input.mode === 'recency_weighted') {
  const recencyConfig = loadRecencyConfig();
  results.sort((a, b) => {
    const aScore = a.current_confidence * a.rrf_score * recencyBoost(ageDays(a.created_at, now), recencyConfig);
    const bScore = b.current_confidence * b.rrf_score * recencyBoost(ageDays(b.created_at, now), recencyConfig);
    return bScore - aScore;
  });
} else {
  // relevance mode (DEFAULT) — original decay re-rank, byte-for-byte unchanged
  results.sort((a, b) => {
    const aScore = a.current_confidence * a.rrf_score;
    const bScore = b.current_confidence * b.rrf_score;
    return bScore - aScore;
  });
}
```

Notes:
- `now` and `ageDays` are the **same** ones the decay pass already uses, so age is
  consistent between decay and the recency boost.
- The recency term lives in the **final sort** (hydrated rows have `created_at`),
  not in `rrf.ts` (which runs pre-hydration and stays pure RRF — untouched).
- `mode` is `z.enum(...).optional()` with **no Zod `.default`**: a `.default`
  would make `mode` *required* in the inferred `RetrieveInput` and force every
  existing caller/test to pass it. The default-to-relevance contract is enforced
  by the sort branch (`undefined` → relevance), keeping the param purely additive.

**Proof relevance mode is byte-unchanged (golden-baseline methodology):**

1. The golden/regression test (`retrieve.recency.test.ts`) was written **first**
   and run against the **pre-edit** `retrieve.ts`. Pre-edit, Zod strips the unknown
   `mode` key, so both `relevance` and `recency_weighted` calls behaved as today's
   ranking. Result: **GOLDEN passed, GUARD passed, FLIP's recency assertion
   failed** — proving (a) the golden order matches current behavior, and (b) the
   flip test genuinely exercises new behavior (it cannot pass without the change).
2. Post-edit, the golden test asserts: default (no `mode`) === explicit
   `mode:'relevance'`, candidate-for-candidate with identical `rrf_score`, in a
   locked order `[a, b, c]` — and is unaffected by drastically varied ages.
3. The **entire pre-existing `retrieve.test.ts` (15 tests) passes unchanged** — it
   never passes `mode`, so it is the broad regression guard for the default path.

---

## 4. Caller wiring — session-start uses recency, all else relevance

Verified there are exactly three `memoryClient.recall(` call sites; only one sets
the mode:

| Call site | Mode | Rationale |
|---|---|---|
| `noah.ts:413` (first-message session-start recap) | `recency_weighted` **iff** `isFirstMessageOfSession` | the one recency-dominant query type |
| `tool-router.ts:412` (model-issued `memory_recall`) | default relevance | opts whitelist is `{topK,type,scope,entities}` — never forwards `mode` |
| `vault-bridge.ts:490` (vault internal recall) | default relevance | not session-start |

**Defense-in-depth so a model cannot opt into recency** (mirrors the existing
`explicit` precedent on `memory_remember`):
1. `tool-router.ts` builds recall opts explicitly and never forwards `mode` from
   model tool-call args.
2. The MCP `memory_recall` `inputSchema` does **not** advertise `mode` — the model
   is never told it exists.
3. `handleRecall` whitelists: `args.mode === 'recency_weighted' ? 'recency_weighted' : undefined`.

---

## 5. Test results

**memory-api (vitest):**
- `recency.test.ts` — **10/10**: `boost(0)=1`; `boost(H)=(1+floor)/2`; monotonic
  decreasing; bounded `[floor,1]`; never zeroes (→floor at age 100k); custom floor;
  longer half-life ⇒ higher boost; negative age clamped; `half_life≤0` disables;
  `loadRecencyConfig` reads `recency.yaml`.
- `retrieve.recency.test.ts` — **3/3**:
  - **FLIP (intro fix):** older memory is *slightly more relevant* (rank 0) and 2
    days old; fresh is rank 1, age 0. `relevance` → `[older, fresh]`;
    `recency_weighted` → `[fresh, older]`. Proves the mode changes ranking (not
    just decay) and surfaces today's memory.
  - **GUARD (old-relevant ≥ fresh-irrelevant):** old memory matches
    semantic+keyword+entity (3 signals), backdated **30 days** (boost ≈ floor);
    fresh matches semantic only. In `recency_weighted`, **old still ranks #1** —
    recency biases, never dominates.
  - **GOLDEN BASELINE:** default === explicit `relevance`, identical `rrf_score`,
    locked order, recency-blind despite 40-day vs 5-day vs 0-day ages.
- Regression: `retrieve.test.ts` (15), `rrf.test.ts` (7), `decay.test.ts` (25) all
  pass unchanged.
- Full suite: the only failures are **7 pre-existing seed-loader tests**
  (`seed/loader.test.ts` + the seed-dependent MCP e2e). Confirmed pre-existing by
  running the suite on the pristine tree (none of these changes present) — same 7
  failures, byte-identical. They are seed-data/embeddings env gaps, unrelated to
  this change.
- Typecheck: the `mode` type error I briefly introduced is resolved by `.optional()`.
  Two remaining `tsc` errors (`server.ts:286`, `seed/loader.ts:119`) are
  pre-existing `category`-cast issues, untouched by this work.

**noah-dev-ui (bun, per-file — known `mock.module` global leak):**
- `noah.test.ts` — **28/28**, including the 2 new caller-wiring tests:
  first-message recall ⇒ `mode === "recency_weighted"`; non-first ⇒ `mode`
  omitted (default relevance). Typecheck clean on `noah.ts` + `memory-client.ts`.

---

## 6. Live check — REMAINING MANUAL STEP (needs Ollama + live model)

Not runnable in this dev environment (the test run shows the live model returning
401/503/timeout, and embeddings need Ollama). Run this against the live stack:

1. Restart memory-api MCP + noah server (fresh embeddings warm).
2. **Intro / recency-dominant:** open a NEW conversation (empty history) and ask
   *"what did we recently discuss?"* → expect Noah to lead with **today's** threads,
   not 2-day-old content-equivalent ones.
3. **Relevance-dominant (the safety check):** as a FOLLOW-UP (non-first message,
   so it routes through `relevance` mode), ask something specific and older
   (e.g. *"what did we decide about provenance a few weeks ago?"*) → expect the
   relevant **older** memory to still surface. Both modes must work.
4. **Observability:** the retrieve audit log now records `mode` per call — confirm
   the first-message recall logs `"mode":"recency_weighted"` and every other recall
   logs `"mode":"relevance"`.

Expected outcome is already de-risked by the FLIP test (recency surfaces fresh) and
the GUARD test (relevance-dominant old memory is not buried).

---

## 7. Explicitly NOT done (tracked Stage 2/3 workstream)

- **No** global recency reweight — it is a per-call mode, default `relevance`.
- **No** change to the three signals, `rrfMerge`, or `relevance`-mode ranking.
- **No** change to `decay.yaml` or reuse of its half-lives.
- **No** relevance-quality fix (resemblance ≠ relevance) and **no** dynamic
  per-query recency/relevance weighting — those remain the separate, tracked
  Stage 2/3 effort. Code comments throughout (`recency.ts`, `retrieve.ts`,
  `recency.yaml`, `noah.ts`, `server.ts`) label this as the interim two-mode fix so
  the next person does not mistake it for the solution.

### Known interim limitation
A first message that is itself a *relevance-dominant* deep-recall query still gets
`recency_weighted` (the mode is selected by `isFirstMessageOfSession`, not by query
classification). The impact is bounded — the boost biases but never buries a
relevant old memory (per the GUARD test) — and proper per-query classification is
exactly the Stage 3 dynamic-weighting work.
