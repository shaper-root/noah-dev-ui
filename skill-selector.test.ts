import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync } from "fs";
import { resolve } from "path";
import {
  scoreSkill,
  matchSkills,
  loadSkillBlock,
  getSkillReferenceTool,
  loadSkillReference,
  loadSkillRegistry,
  selectSkills,
  resetSkillRegistryCache,
  type ParsedSkill,
  type SelectedSkill,
} from "./skill-selector";

// The REAL cc-prompt-engineer frontmatter (skillforge/library/cc-prompt-engineer/
// SKILL.md). Used for hermetic, disk-free matcher tests — the matcher is a pure
// function over this declared metadata.
const CCPE: ParsedSkill = {
  name: "cc-prompt-engineer",
  type: "selective",
  dir: "/tmp/ccpe",
  triggers: [
    "Writing a prompt or task specification for Claude Code to execute",
    "Preparing a CC build prompt for a coding task, feature, or fix",
    "Reviewing or improving an existing CC prompt before execution",
  ],
  antiTriggers: [
    "Writing code directly (not writing a prompt for CC to write code)",
    "General conversation about CC features or configuration",
    "Writing CLAUDE.md rules or hooks (different skill)",
    "Designing an LLM-application prompt — system prompt, tool schema, few-shot (that is prompt-engineering)",
  ],
  references: ["cc-behaviors.md", "prompt-patterns.md"],
  body: "CC PROMPT ENGINEER BODY",
};

// The REAL linkedin-writer frontmatter (skillforge/library/linkedin-writer).
const LINKEDIN: ParsedSkill = {
  name: "linkedin-writer",
  type: "selective",
  dir: "/tmp/li",
  triggers: [
    "Writing a LinkedIn post or drafting LinkedIn content",
    "Reviewing or editing LinkedIn post copy",
    "Planning LinkedIn content strategy or topic pillars",
    "Adapting existing content for LinkedIn publishing",
  ],
  antiTriggers: [
    "Writing for other social platforms without LinkedIn mention",
    "General blog or article writing not targeting LinkedIn",
    "LinkedIn Ads copy, profile optimization, or comment writing",
  ],
  references: [],
  body: "LINKEDIN WRITER BODY",
};

describe("scoreSkill — routing DECISIONS, not just runs", () => {
  // POSITIVES: a CC-prompt request matches (>= 2 distinct distinctive tokens).
  test.each([
    "Write a Claude Code prompt to add authentication",
    "Draft a CC build prompt for the parser module",
    "Help me improve my existing CC prompt for the migration",
    "Write a task specification for Claude Code to build the API",
    "Review and improve this Claude Code prompt before I run it",
  ])("FIRES on CC-prompt request: %s", (msg) => {
    expect(scoreSkill(msg, CCPE)).toBeGreaterThanOrEqual(2);
  });

  // NEGATIVES: unrelated requests, and bare domain mentions, do NOT match.
  test.each([
    "What's the weather in Paris today?",
    "Tell me about Claude Code", // bare domain mention, no prompt-writing intent
    "Write a function to parse JSON",
    "Review this pull request",
    "How do I configure CC's settings?",
  ])("does NOT fire on unrelated/ambiguous request: %s", (msg) => {
    expect(scoreSkill(msg, CCPE)).toBeLessThan(2);
  });

  // REGRESSION (adversarial review HIGH-1): the dominant false-positive class —
  // a message with BOTH 'claude' and 'prompt' but NO authoring intent (it's
  // troubleshooting/discussion). The intent gate must keep these at 0.
  test.each([
    "My prompt to Claude keeps getting cut off",
    "What's the best prompt to ask Claude to summarize a PDF?",
    "Why is Claude so slow to execute long prompts?",
    "Explain how prompt caching works in the Claude API",
    "Claude rewrote my prompt and now it's worse",
    "Run this prompt through Claude and tell me what it says",
    "Here's my prompt: You are Claude. Make it better.",
  ])("does NOT fire on claude+prompt with no authoring intent: %s", (msg) => {
    expect(scoreSkill(msg, CCPE)).toBe(0);
  });

  test("intent gate: a domain-rich message with no authoring verb scores 0", () => {
    // 'claude' + 'prompt' + 'execution' present, but no write/draft/review verb.
    expect(scoreSkill("Claude's prompt execution is slow", CCPE)).toBe(0);
  });

  test("domain gate: an authoring verb with < 2 domain tokens does not fire", () => {
    expect(scoreSkill("Write a prompt for my chatbot", CCPE)).toBeLessThan(2);
  });

  // REGRESSION (re-attack SEV-1): an authoring verb whose OBJECT is something
  // other than a CC prompt must not fire, even when the sentence is dense with
  // claude/cc/prompt/execution tokens. The verb-object gate excludes these.
  test.each([
    "Write a function to parse the Claude API response and execute it",
    "Compose an email explaining how Claude Code prompt execution works",
    "Generate test data for the prompt execution pipeline in Claude",
    "Build a dashboard to track Claude prompt token usage",
    "Create a CC extension that logs every prompt",
    "Edit the README section that documents Claude Code prompt execution",
    "Improve the database query that stores each Claude prompt and execution time",
    "Write a haiku about Claude and a prompt",
  ])("does NOT fire when the authoring verb's object is foreign: %s", (msg) => {
    expect(scoreSkill(msg, CCPE)).toBeLessThan(2);
  });

  // REGRESSION (re-attack SEV-2): the anti-trigger "Writing code directly (not
  // writing a prompt for CC...)" used to self-veto these genuine requests via the
  // parenthetical. Stripping parentheticals fixes the false negatives.
  test.each([
    "Writing a prompt for Claude Code to build the API",
    "Generate a build prompt for CC to fix the flaky test",
  ])("FIRES on a genuine request the anti-trigger parenthetical used to veto: %s", (msg) => {
    expect(scoreSkill(msg, CCPE)).toBeGreaterThanOrEqual(2);
  });

  // ANTI-TRIGGERS: a would-be match is VETOED to exactly 0.
  test("anti-trigger VETOES a request that otherwise scores >= 2", () => {
    // "Claude" + "prompt" would score 2, but "system prompt" is an anti-trigger.
    const msg = "Design a system prompt for Claude Code";
    expect(scoreSkill(msg, CCPE)).toBe(0);
  });

  test("anti-trigger 'writing code directly' vetoes", () => {
    expect(scoreSkill("Writing code directly in the CC repo", CCPE)).toBe(0);
  });
});

describe("scoreSkill — linkedin-writer routing (adversarial review HIGH-2)", () => {
  // POSITIVES: genuine LinkedIn authoring requests, including the skill's own
  // declared trigger verbs (Planning…, Adapting…) which must be fireable.
  test.each([
    "Write a LinkedIn post about our product launch",
    "Draft a LinkedIn post on AI trends for next week",
    "Review and edit my LinkedIn post copy before I publish",
    "Adapt this content for LinkedIn publishing",
    "Plan LinkedIn content strategy and topic pillars for Q3",
  ])("FIRES on LinkedIn request: %s", (msg) => {
    expect(scoreSkill(msg, LINKEDIN)).toBeGreaterThanOrEqual(2);
  });

  // NEGATIVES: cross-platform / generic-content questions that wrongly fired in v1.
  test.each([
    "What's a good content strategy for my YouTube channel?",
    "Adapting our existing content into a podcast strategy",
    "What topic should my next blog post cover?",
    "Plan my content strategy for the quarter across all channels",
  ])("does NOT fire on non-LinkedIn content question: %s", (msg) => {
    expect(scoreSkill(msg, LINKEDIN)).toBeLessThan(2);
  });

  test("anti-trigger vetoes LinkedIn Ads copy", () => {
    expect(scoreSkill("Write LinkedIn Ads copy for our campaign", LINKEDIN)).toBe(0);
  });
});

describe("never-throws contract (adversarial review CRITICAL — kernel-drop guard)", () => {
  // A non-string message must NEVER throw out of the selector: it runs before the
  // kernel-bearing system message is assembled, outside noah.ts's try/catch, so a
  // throw would drop the always-on kernel. It must degrade to no-selection.
  test.each([123, [1, 2], { a: 1 }, true, null, undefined])(
    "selectSkills/scoreSkill never throw on non-string input: %p",
    (bad) => {
      expect(() => selectSkills(bad as any)).not.toThrow();
      expect(selectSkills(bad as any)).toEqual([]);
      expect(() => scoreSkill(bad as any, CCPE)).not.toThrow();
      expect(scoreSkill(bad as any, CCPE)).toBe(0);
    },
  );
});

describe("matchSkills — selection + ranking + caps", () => {
  test("selects cc-prompt-engineer on a matching message", () => {
    const sel = matchSkills("Write a Claude Code prompt to add auth", [CCPE]);
    expect(sel.map((s) => s.name)).toEqual(["cc-prompt-engineer"]);
    expect(sel[0].references).toEqual(["cc-behaviors.md", "prompt-patterns.md"]);
  });

  test("selects nothing on a non-matching message", () => {
    expect(matchSkills("what's the weather", [CCPE])).toEqual([]);
  });

  test("ignores non-selective skills entirely", () => {
    const proc: ParsedSkill = { ...CCPE, name: "x", type: "procedural" };
    expect(matchSkills("Write a Claude Code prompt to add auth", [proc])).toEqual([]);
  });

  test("honors the soft cap (maxSkills)", () => {
    const a: ParsedSkill = { ...CCPE, name: "a" };
    const b: ParsedSkill = { ...CCPE, name: "b" };
    const c: ParsedSkill = { ...CCPE, name: "c" };
    const sel = matchSkills("Write a Claude Code prompt to add auth", [a, b, c], 2);
    expect(sel.length).toBe(2);
  });
});

describe("loadSkillBlock — the INVIOLABLE byte-identity property", () => {
  test("empty selection -> empty string (system prompt byte-identical)", () => {
    const r = loadSkillBlock([]);
    expect(r.text).toBe("");
    expect(r.tokenEstimate).toBe(0);
    expect(r.injected).toEqual([]);
  });
});

describe("skill_reference tool — gating + security whitelist", () => {
  test("no tool when nothing selected", () => {
    expect(getSkillReferenceTool([])).toBeNull();
  });

  test("no tool when selected skill has no references", () => {
    const sel: SelectedSkill = { name: "x", dir: "/tmp/x", score: 2, references: [] };
    expect(getSkillReferenceTool([sel])).toBeNull();
  });

  test("tool enum is the whitelist of '<skill>/<file>' ids", () => {
    const sel: SelectedSkill = {
      name: "cc-prompt-engineer",
      dir: "/tmp/ccpe",
      score: 2,
      references: ["cc-behaviors.md", "prompt-patterns.md"],
    };
    const tool = getSkillReferenceTool([sel]);
    expect(tool).not.toBeNull();
    const en = (tool!.function.parameters as any).properties.reference.enum;
    expect(en).toEqual([
      "cc-prompt-engineer/cc-behaviors.md",
      "cc-prompt-engineer/prompt-patterns.md",
    ]);
  });

  test("rejects a reference outside this turn's whitelist", () => {
    const sel: SelectedSkill = { name: "x", dir: "/tmp/x", score: 2, references: ["a.md"] };
    const out = JSON.parse(loadSkillReference([sel], { reference: "x/evil.md" }));
    expect(out.error).toBeTruthy();
  });

  // The whitelist is EXACT-MATCH, so each of these is rejected with an error AND
  // — critically — no `content` field ever leaks. Locks the boundary against a
  // future refactor that might rebuild the path before checking the whitelist.
  test.each([
    "x/../../../etc/passwd",
    "/etc/passwd",
    "x//a.md",
    "X/A.MD", // case variant — enum is case-sensitive
    "x/a/b.md", // multi-slash
    "y/a.md", // a skill not in this turn's selection
    "x/a.md .md", // near-miss basename, not an exact whitelist entry
    "",
  ])("rejects out-of-whitelist reference '%s' and leaks no content", (ref) => {
    const sel: SelectedSkill = { name: "x", dir: "/tmp/x", score: 2, references: ["a.md"] };
    const out = JSON.parse(loadSkillReference([sel], { reference: ref }));
    expect(out.error).toBeTruthy();
    expect(out.content).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LIVE integration against the real skillforge library (Stage 3 selector proof).
// Guarded so the suite still passes if the sibling repo isn't checked out.
// ---------------------------------------------------------------------------
const LIBRARY = resolve(import.meta.dir, "../../skillforge/library");
const haveLibrary = existsSync(LIBRARY);

describe("LIVE registry + selection (real skillforge/library)", () => {
  beforeEach(() => resetSkillRegistryCache());

  test.skipIf(!haveLibrary)("parses cc-prompt-engineer as a selective skill", () => {
    const reg = loadSkillRegistry();
    const ccpe = reg.find((s) => s.name === "cc-prompt-engineer");
    expect(ccpe).toBeTruthy();
    expect(ccpe!.type).toBe("selective");
    expect(ccpe!.triggers.length).toBe(3);
    expect(ccpe!.antiTriggers.length).toBe(4);
    expect(ccpe!.references.sort()).toEqual(["cc-behaviors.md", "prompt-patterns.md"]);
    expect(ccpe!.body.length).toBeGreaterThan(100);
  });

  test.skipIf(!haveLibrary)("selectSkills loads cc-prompt-engineer on a CC-prompt request", () => {
    const sel = selectSkills("Write a Claude Code prompt to add authentication");
    expect(sel.map((s) => s.name)).toContain("cc-prompt-engineer");
  });

  test.skipIf(!haveLibrary)("selectSkills loads nothing on an unrelated request", () => {
    const sel = selectSkills("what's the weather in Paris today?");
    expect(sel.map((s) => s.name)).not.toContain("cc-prompt-engineer");
  });

  test.skipIf(!haveLibrary)("loadSkillBlock injects the real body, fenced", () => {
    const sel = selectSkills("Write a Claude Code prompt to add authentication");
    const block = loadSkillBlock(sel);
    expect(block.text).toContain("=== TASK SKILL: cc-prompt-engineer (selected for this turn) ===");
    expect(block.text).toContain("=== END TASK SKILL: cc-prompt-engineer ===");
    expect(block.tokenEstimate).toBeGreaterThan(0);
  });

  test.skipIf(!haveLibrary)("loadSkillReference reads a real whitelisted reference", () => {
    const sel = selectSkills("Write a Claude Code prompt to add authentication");
    const out = JSON.parse(
      loadSkillReference(sel, { reference: "cc-prompt-engineer/prompt-patterns.md" }),
    );
    expect(out.error).toBeUndefined();
    expect(out.content.length).toBeGreaterThan(100);
  });
});
