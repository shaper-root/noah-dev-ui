/**
 * Observational skill-activation detection (P2).
 *
 * Lightweight pattern heuristics that guess which kernel skills appear to have
 * fired in a response, from its surface form. This is NOT a classifier and makes
 * no claim of precision — it feeds the structured log so the eventual Sleipnir
 * quality loop has a cheap, always-on signal. Treat the output as a hint, not
 * ground truth. (Track 2 assesses whether this is reliable enough.)
 *
 * The kernel's own OUTPUT FORMAT markers (⚡ assumption, ~? uncertain, ⟳ anchor,
 * △ change) are high-precision when present, because the kernel instructs the model
 * to emit them. The prose heuristics (pushback, ground-check) are lower precision.
 */

export interface SkillSignal {
  skill: string;
  /** "marker" = kernel glyph (high precision); "prose" = phrase heuristic (lower). */
  basis: "marker" | "prose";
}

/** Did the user state a position and ask for input? Gates the sycophancy heuristic. */
function userStatedPosition(userMessage: string): boolean {
  return /\b(i think|i reckon|my plan is|we should|don'?t you think|shouldn'?t we|let'?s just|i want to|i'?m going to)\b/i.test(
    userMessage,
  );
}

const PUSHBACK_PHRASES =
  /\b(however|that said|the (counter|risk|downside|catch|concern)|one (risk|concern|downside)|i'?d push back|i'?d caution|the trade-?off|on the other hand|before you|i'?d hold off|worth (considering|flagging))\b/i;

const GROUND_CHECK_PHRASES =
  /\b(i don'?t have|i can'?t (check|verify|access)|no access to (live|real-?time)|let me check|i checked|nothing (came|came back|found)|i don'?t see)\b/i;

const SCOPE_HEDGE =
  /\b(short version|in short|briefly|the quick answer)\b/i;

/**
 * Detect apparent skill activations. `userMessage` gates context-dependent skills
 * (e.g. sycophancy-guard only counts when the user actually staked a position).
 */
export function detectSkills(
  responseText: string,
  userMessage: string,
): string[] {
  const out: SkillSignal[] = [];
  const text = responseText;

  // --- High-precision kernel markers ---
  if (text.includes("⚡")) out.push({ skill: "assumption-surfacing", basis: "marker" });
  if (text.includes("~?")) out.push({ skill: "confidence-calibration", basis: "marker" });
  if (text.includes("⟳")) out.push({ skill: "drift-guard", basis: "marker" });
  if (text.includes("△")) out.push({ skill: "drift-guard", basis: "marker" });
  if (text.includes("✓△")) out.push({ skill: "drift-guard", basis: "marker" });

  // --- Lower-precision prose heuristics ---
  if (userStatedPosition(userMessage) && PUSHBACK_PHRASES.test(text)) {
    out.push({ skill: "sycophancy-guard", basis: "prose" });
  }
  if (GROUND_CHECK_PHRASES.test(text)) {
    out.push({ skill: "ground-check", basis: "prose" });
  }
  // Assumption surfaced in prose without the glyph (kernel marker missed).
  if (!text.includes("⚡") && /\bassuming\b/i.test(text)) {
    out.push({ skill: "assumption-surfacing", basis: "prose" });
  }
  // Uncertainty hedged in prose without the glyph.
  if (!text.includes("~?") && /\b(i'?m not (sure|certain)|can'?t be certain|my best guess|roughly)\b/i.test(text)) {
    out.push({ skill: "confidence-calibration", basis: "prose" });
  }
  if (SCOPE_HEDGE.test(text)) {
    out.push({ skill: "scope-match", basis: "prose" });
  }

  // De-dup by skill, preferring marker basis (already first in push order).
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const s of out) {
    if (!seen.has(s.skill)) {
      seen.add(s.skill);
      skills.push(s.skill);
    }
  }
  return skills;
}
