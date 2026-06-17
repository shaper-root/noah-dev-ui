import { describe, test, expect } from "bun:test";
import { coerceMemoryArgs } from "./tool-router";

// Pure-function tests. The full dispatchTool path is covered by
// noah.test.ts (which mocks ./tool-router) and live verification
// (Tom Ford sunglasses test from the bug report). Testing coerceMemoryArgs
// directly avoids bun's process-global mock.module interference with the
// other test files that mock ./memory-client.

describe("coerceMemoryArgs", () => {
  test("schema-valid type passes through unchanged", () => {
    for (const t of [
      "fact",
      "value",
      "preference",
      "constraint",
      "convention",
      "principle",
      "goal",
      "relationship",
      "boundary",
      "event",
      "skill",
      "context",
    ]) {
      expect(coerceMemoryArgs({ type: t }).type).toBe(t);
    }
  });

  test("schema-valid category passes through unchanged", () => {
    for (const c of ["permanent", "durable", "stable", "evolving", "volatile"]) {
      expect(coerceMemoryArgs({ category: c }).category).toBe(c);
    }
  });

  test("legacy 'feedback' → 'constraint'", () => {
    expect(coerceMemoryArgs({ type: "feedback" }).type).toBe("constraint");
  });

  test("legacy 'instruction' → 'constraint'", () => {
    expect(coerceMemoryArgs({ type: "instruction" }).type).toBe("constraint");
  });

  test("legacy 'belief' → 'principle' and 'habit' → 'convention'", () => {
    expect(coerceMemoryArgs({ type: "belief" }).type).toBe("principle");
    expect(coerceMemoryArgs({ type: "habit" }).type).toBe("convention");
  });

  test("legacy 'insight' → 'fact' and 'experience' → 'event'", () => {
    expect(coerceMemoryArgs({ type: "insight" }).type).toBe("fact");
    expect(coerceMemoryArgs({ type: "experience" }).type).toBe("event");
  });

  test("totally unknown type falls back to 'fact'", () => {
    expect(coerceMemoryArgs({ type: "wholly_unknown" }).type).toBe("fact");
    expect(coerceMemoryArgs({ type: "" }).type).toBe("fact");
  });

  test("invalid category is dropped to undefined (NULL on the DB side)", () => {
    for (const bad of ["identity", "situational", "ephemeral", "elephant"]) {
      expect(coerceMemoryArgs({ category: bad }).category).toBeUndefined();
    }
  });

  test("omitted args produce undefined outputs (memory-api will default)", () => {
    expect(coerceMemoryArgs({}).type).toBeUndefined();
    expect(coerceMemoryArgs({}).category).toBeUndefined();
  });

  test("Tom Ford sunglasses live-bug scenario stays schema-valid end-to-end", () => {
    // The actual rejection was a CHECK constraint failure because the model
    // picked one of the OLD invalid enums. Lock in: every old invalid value
    // we observed in prod logs gets coerced to a schema-valid value, not
    // dropped, not nullified for type.
    const old = ["experience", "belief", "habit", "instruction", "feedback", "insight"];
    for (const t of old) {
      const out = coerceMemoryArgs({ type: t, category: "ephemeral" });
      expect(out.type).toBeDefined();
      expect(out.category).toBeUndefined();
    }
  });

  test("non-string inputs are treated as absent (not coerced to 'fact')", () => {
    // null/number/object → don't touch them. The memory-api side will reject
    // with a schema error; coercing arbitrary types to 'fact' would mask bugs.
    expect(coerceMemoryArgs({ type: null as unknown as string }).type).toBeUndefined();
    expect(coerceMemoryArgs({ type: 42 as unknown as string }).type).toBeUndefined();
    expect(coerceMemoryArgs({ category: ["x"] as unknown as string }).category).toBeUndefined();
  });
});
