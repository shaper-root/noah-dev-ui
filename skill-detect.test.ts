import { describe, test, expect } from "bun:test";
import { detectSkills } from "./skill-detect";

describe("detectSkills", () => {
  test("no signals on a bare agreement", () => {
    expect(detectSkills("Sure, great idea!", "I think we should ship")).toEqual([]);
  });

  test("kernel glyph markers are detected (high precision)", () => {
    const s = detectSkills("⚡ Assuming you mean prod. ~? Not certain.", "deploy?");
    expect(s).toContain("assumption-surfacing");
    expect(s).toContain("confidence-calibration");
  });

  test("change/anchor glyphs map to drift-guard", () => {
    expect(detectSkills("△ Prior said X, changed because Y.", "status?")).toContain(
      "drift-guard",
    );
    expect(detectSkills("⟳ Same as before.", "status?")).toContain("drift-guard");
  });

  test("sycophancy-guard fires only when the user staked a position", () => {
    const withPosition = detectSkills(
      "That said, the risk is downtime. I'd push back.",
      "I think we should ship tonight",
    );
    expect(withPosition).toContain("sycophancy-guard");

    const noPosition = detectSkills(
      "That said, the risk is downtime.",
      "what is the weather",
    );
    expect(noPosition).not.toContain("sycophancy-guard");
  });

  test("ground-check fires on no-live-data hedges", () => {
    expect(
      detectSkills("I don't have access to live weather.", "weather this weekend?"),
    ).toContain("ground-check");
  });

  test("de-dups skills detected by multiple bases", () => {
    const s = detectSkills("⚡ Assuming prod. I'm assuming a lot here.", "deploy?");
    expect(s.filter((x) => x === "assumption-surfacing").length).toBe(1);
  });
});
