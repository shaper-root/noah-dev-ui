# Provenance as an edit-history log — the future model (design stub)

**Status:** DESIGN NOTE ONLY — not built. This documents the ideal state the
operator described, so the interim (`provenance.ts`) is explicitly an interim and
the next builder inherits the design. Do not treat anything here as implemented.

**Author context:** Okeanos Sprint 2 provenance hardening, 2026-06-18.
Companion to `provenance.ts` (the interim scalar classifier) and
`docs/checkpoint-provenance-hardening.md` (the flip that shipped before merge).

---

## The interim we ship today

`provenance.ts` returns a single scalar trust label per file:

- `authored` (0.9) — reachable ONLY via `AUTHORED_ALLOWLIST` (a narrow, curated,
  location-based set the file's content cannot forge).
- `imported` / `unknown` (0.5) — everything else: ingested, machine-written,
  loose-root, ambiguous, or simply not positively known to be authored.

The posture is **default-low + narrow-authored-allowlist**:

- **Under-trust is graceful.** Noah surfaces an authored-but-unverified file and
  asks Root to confirm (the Elenchus / surface-and-ask principle). Mild friction.
- **Over-trust is an injection vector.** A file wrongly presented as authoritative
  feeds the conflict-detector content that can override what Root actually said.

So 0.9 is made hard to reach. That is correct as a floor — but it is a lossy
approximation of the real shape of vault provenance.

## Why a single label is the wrong shape

Vault files are **co-edited**, not authored once by one party:

- Root drafts a note; an agent later edits, expands, or restructures it.
- An agent drafts a note (a brief, a synthesis, a scaffold); Root reviews,
  corrects, and adopts it.
- Both interleave over a file's lifetime.

A single per-file `authored | imported` bit cannot represent "Root wrote lines
1–40, an agent rewrote line 41 last Tuesday." Forced to pick one label, the safe
choice is the lower one (what we do) — but that under-trusts genuinely-Root-
authored material and over-coarsens the signal the conflict-detector consumes.

## The target model — a per-edit attribution log

Provenance should be an **edit-history LOG**, analogous to the memory system's
supersession lineage applied to vault files:

- Each edit records **who** (Root / a named agent / a bulk-import job),
  **when**, and **what** (the span or the diff).
- The log is append-only and **authoritative from outside the file** — it is
  never derived from a field the file's own content controls (the forgery class
  the interim already refuses). Source it from the editor/runtime, an external
  index, or git-style history — not from `created_by:` in the frontmatter.
- Trust becomes a **function over the log** (e.g. "Root-authored span, last
  touched by Root" → high; "agent-written span, never Root-reviewed" → low),
  computed per span, not per file.

## What the conflict-detector consumes then

Instead of a single trust number per vault hit, the detector keys on the log for
the **specific contradicting span**:

> "The contradicting line was agent-written last Tuesday and never reviewed by
> Root; the rest of the note is Root-authored."

That lets it frame a conflict precisely — surfacing the agent-written span as
unverified while still treating the Root-authored remainder as authoritative —
rather than collapsing the whole file to one label. The Stage-2 tag framing
(`imported_unverified` vs authoritative `stored=`) generalizes naturally: it
becomes per-span rather than per-file.

## Migration path (when this is built)

1. Start emitting an edit-log sidecar/index on every vault write the runtime
   controls (`writeNote`/`appendToNote` in `vault.ts`), keyed by path + span.
2. Keep `classifyProvenance` as the fallback for files with no log yet
   (default-low remains the safe floor during backfill).
3. Teach `vaultProvenance` to prefer the log when present, returning per-span
   attribution; widen the conflict-detector input from `VaultFactInput` (one
   trust scalar) to a span-attributed structure.
4. Retire `AUTHORED_ALLOWLIST` only once the log covers the authored surface —
   the allowlist is the interim's narrow proxy for "known Root-authored."

Until all four exist, the interim stands: **default-low, narrow-authored-
allowlist, location-only promotion, content never raises its own trust.**
