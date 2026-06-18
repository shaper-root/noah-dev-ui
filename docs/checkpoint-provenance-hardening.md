# Checkpoint — Provenance Hardening (default-direction flip)

**Date:** 2026-06-18 · **Branch:** `sprint2-frontload-compiler-integrity`
**Scope:** `provenance.ts` only (+ its tests + two docs). Own commit, runs BEFORE
the merge so merged `main` ships hardened provenance.
**Source:** dual review (manual + Cowork ground-truth audit) +
`docs/audit-okeanos-fullstack-2026-06-17.md`.
**Module purity preserved:** no fs writes added; classification stays read-only.

---

## 1. The default flip — old logic → new logic

**Root cause (single inverted assumption):** the old classifier granted
authored/0.9 on the **absence of a demotion signal** — a folder was in an
authored set (or `folder === ""`), nothing demoted it → 0.9. "Absence of a reason
to distrust" was treated as "a reason to trust" (the exact confirmation-bias error
the kernel's disconfirmation-discipline names).

### Old logic (fail-OPEN)
```
1. external-ingest marker        → imported
2. IMPORT_FOLDERS                → imported
3. MIXED_FOLDERS (03-outreach)   → imported, UNLESS hasAuthoredMarker(fm) → authored
4. AUTHORED_FOLDERS  OR  folder === ""   → authored   ← fail-open: absence ⇒ trust
5. else                          → unknown
AUTHORED_FOLDERS = {02-library, 05-projects, 00-dashboard, _agent, _archive, short story}
```

### New logic (default-LOW)
```
1. external-ingest marker        → imported   (overrides the allowlist; demotion wins)
2. AUTHORED_ALLOWLIST            → authored   (0.9 — the ONLY path up, location-only)
3. IMPORT_FOLDERS                → imported   (0.5, honest label)
4. else (loose root, unmarked, undeterminable) → unknown (0.5, fail-safe)
AUTHORED_ALLOWLIST = {short story}
```

Net effect: authored is now reached **only** by positive, location-based,
unforgeable membership. Loose-root, unmarked, ingested, and ambiguous all default
to 0.5. There is **no** path from folder-absence or a content-controlled field to
0.9.

### Proposed authored allowlist — FLAGGED FOR OPERATOR CONFIRMATION
| Folder | Decision | Confidence | Rationale |
|---|---|---|---|
| `short story` | **ACTIVE (authored)** | High | Root's creative writing; no import pipeline. |
| `05-projects` | **CANDIDATE — left OFF** | Medium | Root's project notes. Add IFF confirmed free of pasted/ingested external material. Until confirmed → 0.5 (safe). |
| `02-library` | REMOVED → 0.5 | — | 373/475 files `created_by: bulk import` (hole #2). |
| `00-dashboard` | REMOVED → 0.5 | — | Holds machine-generated daily briefs. |
| `_agent`, `_archive` | REMOVED → 0.5 | — | Agent-written output; operator confirmed `_archive` is agent output. |
| loose root `""` | REMOVED → 0.5 | — | Holds `Noah-Self-Knowledge.md`, Noah's own writes (hole #1). |

> **Operator action:** confirm `short story` is correct and decide `05-projects`.
> To add a folder: append one lowercased string to `AUTHORED_ALLOWLIST` in
> `provenance.ts`. Leaving it off is always the safe direction.

---

## 2. Audit holes — confirmed closed (before/after trust)

| Case | Path | Before | After | How |
|---|---|---|---|---|
| **HOLE #1 — self-injection (critical)** | `Noah-Self-Knowledge.md` (root) | **0.9 authored** | **0.5 unknown** | loose-root fail-open removed; `""` falls through to default-low |
| | `Welcome.md`, `Seed 2.0.md`, `Fable Notes.md` (root) | 0.9 | **0.5** | same |
| **HOLE #2 — bulk-import blanket (high)** | `02-library/**` (`created_by: bulk import`) | **0.9 authored** | **0.5 unknown** | 02-library off the allowlist; `bulk import` is not an authorship signal |
| | `02-library/**` (`created_by: n8n auto-detection`) | 0.5 | 0.5 imported | external marker still demotes |
| **FORGERY (latent)** | any file with `created_by: root`/`manual` in its OWN frontmatter | could reach **0.9** (in 03-outreach) | **≤0.5, never authored** | promotion-from-content path deleted |
| Allowlisted authored | `short story/**` | 0.9 | **0.9 authored** | preserved (allowlist) |
| Already-correct | `03-outreach/**` | 0.5 imported | **0.5 imported** | moved MIXED→IMPORT_FOLDERS; keeps `imported` label |
| Already-correct | `04-intel`, `_noah` | 0.5 | 0.5 | unchanged |
| Excluded/low | `06-sensitive`, `_raw` | excluded → 0.5 | excluded → 0.5 | unchanged (vault-layer exclusion + path-only → unknown) |

All asserted in `provenance.test.ts` (16 tests, green, run per-file).

---

## 3. The forgeable-marker path — closed, how

The old `hasAuthoredMarker(fm)` read `created_by`/`author`/`updated_by` from the
file's **own frontmatter** and promoted to authored on `manual`/`root`. A file
could therefore assert its own authorship — the SEC-1 self-promotion class
(content asserting its own trust). The import path populates these fields and the
values are guessable.

**Closed by deletion.** `hasAuthoredMarker`, the `AUTHORED_MARKERS` allowlist, and
`MIXED_FOLDERS` (its only caller) are gone. Provenance is now **never** raised to
authored on the strength of a content-controlled field. The `ORIGIN_KEYS`
frontmatter read survives but is used **only to DEMOTE** (external-ingest markers
toward 0.5), never to promote. Promotion is location-only (`AUTHORED_ALLOWLIST`).
03-outreach lost its per-file promotion and now sits at imported/0.5 via
`IMPORT_FOLDERS` — which is what the audit wanted ("03-outreach → still imported").

---

## 4. `isNeutralMigration` — DELETED

The audit flagged it defined-but-never-called. With the flip, migration markers
(`bulk import` / `v2 migration` / `seed-synthesis`) are **moot**: everything
defaults low, so there is nothing to keep neutral. Wiring it in would add a
no-op branch. **Deleted** to remove dead code (chosen over wiring per the spec's
preference). The `bulk import` neutrality it encoded is no longer needed because
02-library is no longer authored.

---

## 5. Belt-and-suspenders markers added

`EXTERNAL_INGEST_MARKERS` gained `agent-brief` and `bulk-import-scaffold` (audit's
missing markers) for completeness/documentation. They demote to imported even
though the flipped default already catches the folders they appear in — they bite
only on a file that would otherwise be allowlisted-authored.

---

## 6. Edit-log stub — where the design note lives

Stubbed, **not built**:
- Code-comment block at the top of `provenance.ts` ("INTERIM SCALAR …").
- Full design note: **`docs/provenance-edit-log-future.md`** — provenance ideally
  is a per-edit attribution LOG (who/when/what), analogous to the memory system's
  supersession lineage; the conflict-detector would consume the log
  ("contradicting line was agent-written last Tuesday, the rest is Root-authored")
  rather than a single scalar. Default-low + narrow-allowlist is the safe interim.

---

## 7. Conflict-detector tag framing — still correct under the new distribution

Verified against the consumers (read, not assumed):
- `conflict-detector.ts` `storedFromVault` (line 287) sets `imported = provenance
  !== "authored"`, and `isImportedSource` (87–94) frames `vault_imported`,
  `vault_unknown`, and any `trust ≤ 0.6` as `imported_unverified`. So **both** new
  0.5 labels (imported AND unknown) frame as imported_unverified; only allowlisted
  0.9 frames as authoritative (`stored=`). The authored-vs-imported distinction the
  Stage-1 disconfirmation validation relies on is preserved — a `short story` hit
  frames authored, every other vault hit frames imported_unverified.
- `data-boundary.ts` `wrapVaultAsData` (190) emits the "Root did not author this"
  note for `provenance !== "authored"` — imported and unknown behave identically.
- Shrinking the authored surface only **adds** safe imported-framing; it cannot
  break tag emission. **Tests:** conflict-detector 16/16, data-boundary 27/27,
  vault 26/26, tool-router 13/13, vault-index 14/14 — all green.

---

## 8. Noticed, not acted (out of scope for this focused fix)

- **`05-projects` final call** is the operator's — shipped OFF (safe). One-line add
  when confirmed.
- **data-boundary wording for `unknown`:** the note says "Root did not author this"
  for both imported AND unknown; for a genuinely-undetermined `unknown` file
  (e.g. `Seed 2.0.md`, actually Root's but unverifiable) the honest phrasing is
  "authorship unverified," not "Root did not author." Security-equivalent (both
  non-authoritative). Left as-is — touching data-boundary is out of this fix's
  scope (SEC-1 owns that file). Flagged for a follow-up.
- **Other audit items** (SEC-1 already fixed in `9e31cac`; FUNC-1/3 compiler
  truncation; SCAL-1 searchVault cache; `_raw` not in `ALWAYS_EXCLUDE`, SEC-2) are
  separate worklist items, untouched here.

---

**Status:** complete. After commit: operator merges everything to `main` +
restarts Noah; the model-agnostic rewrite then proceeds on hardened, merged main.
