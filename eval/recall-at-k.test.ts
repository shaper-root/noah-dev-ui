import { describe, test, expect } from "bun:test";
import {
  checkRecall,
  validateFixtures,
  formatReport,
  FIXTURES,
  type RecallFixture,
  type HarnessReport,
} from "./recall-at-k";

describe("validateFixtures", () => {
  test("built-in FIXTURES pass validation", () => {
    const errors = validateFixtures(FIXTURES);
    expect(errors).toEqual([]);
  });

  test("detects duplicate IDs", () => {
    const dupes: RecallFixture[] = [
      { id: "a", description: "first", seedMemories: [{ content: "x", type: "fact" }], query: "q", expectedContent: "x", k: 5 },
      { id: "a", description: "second", seedMemories: [{ content: "y", type: "fact" }], query: "q2", expectedContent: "y", k: 5 },
    ];
    const errors = validateFixtures(dupes);
    expect(errors).toContain("Duplicate fixture id: a");
  });

  test("detects missing query", () => {
    const bad: RecallFixture[] = [
      { id: "b", description: "no query", seedMemories: [{ content: "x", type: "fact" }], query: "", expectedContent: "x", k: 5 },
    ];
    const errors = validateFixtures(bad);
    expect(errors.some((e) => e.includes("missing query"))).toBe(true);
  });

  test("detects positive fixture with no seeds", () => {
    const bad: RecallFixture[] = [
      { id: "c", description: "positive but empty", seedMemories: [], query: "what?", expectedContent: "something", k: 5 },
    ];
    const errors = validateFixtures(bad);
    expect(errors.some((e) => e.includes("positive fixture needs seed"))).toBe(true);
  });

  test("allows negative fixture with no seeds", () => {
    const ok: RecallFixture[] = [
      { id: "d", description: "negative", seedMemories: [], query: "gibberish", expectedContent: "", k: 5 },
    ];
    const errors = validateFixtures(ok);
    expect(errors).toEqual([]);
  });
});

describe("checkRecall", () => {
  const fixture: RecallFixture = {
    id: "test-1",
    description: "test",
    seedMemories: [],
    query: "test query",
    expectedContent: "Earl Grey",
    k: 5,
  };

  test("passes when expectedContent found at rank 1", () => {
    const memories = [
      { content: "Root likes Earl Grey tea" },
      { content: "Kitchen light is broken" },
    ];
    const result = checkRecall(fixture, memories, 42);
    expect(result.pass).toBe(true);
    expect(result.rank).toBe(1);
    expect(result.latency_ms).toBe(42);
  });

  test("passes when expectedContent found at lower rank", () => {
    const memories = [
      { content: "Kitchen light is broken" },
      { content: "Root prefers oat milk" },
      { content: "Root likes Earl Grey tea" },
    ];
    const result = checkRecall(fixture, memories, 30);
    expect(result.pass).toBe(true);
    expect(result.rank).toBe(3);
  });

  test("fails when expectedContent not in results", () => {
    const memories = [
      { content: "Kitchen light is broken" },
      { content: "Root prefers oat milk" },
    ];
    const result = checkRecall(fixture, memories, 20);
    expect(result.pass).toBe(false);
    expect(result.rank).toBeNull();
  });

  test("fails when results are empty", () => {
    const result = checkRecall(fixture, [], 10);
    expect(result.pass).toBe(false);
    expect(result.rank).toBeNull();
    expect(result.total_results).toBe(0);
  });

  test("respects k limit — ignores results beyond k", () => {
    const smallK: RecallFixture = { ...fixture, k: 2 };
    const memories = [
      { content: "unrelated 1" },
      { content: "unrelated 2" },
      { content: "Root likes Earl Grey tea" },
    ];
    const result = checkRecall(smallK, memories, 15);
    expect(result.pass).toBe(false);
    expect(result.rank).toBeNull();
  });

  test("negative fixture passes when no results", () => {
    const neg: RecallFixture = { ...fixture, expectedContent: "", id: "neg" };
    const result = checkRecall(neg, [], 5);
    expect(result.pass).toBe(true);
    expect(result.rank).toBeNull();
  });

  test("negative fixture fails when results returned", () => {
    const neg: RecallFixture = { ...fixture, expectedContent: "", id: "neg" };
    const memories = [{ content: "something unrelated" }];
    const result = checkRecall(neg, memories, 5);
    expect(result.pass).toBe(false);
  });

  test("records total_results from full array, not top-k", () => {
    const smallK: RecallFixture = { ...fixture, k: 1 };
    const memories = [
      { content: "Root likes Earl Grey tea" },
      { content: "another" },
      { content: "yet another" },
    ];
    const result = checkRecall(smallK, memories, 10);
    expect(result.pass).toBe(true);
    expect(result.rank).toBe(1);
    expect(result.total_results).toBe(3);
  });
});

describe("formatReport", () => {
  const report: HarnessReport = {
    total: 3,
    passed: 2,
    failed: 1,
    results: [
      { fixture_id: "fact-tea", pass: true, rank: 1, total_results: 3, latency_ms: 45 },
      { fixture_id: "pref-music", pass: true, rank: 2, total_results: 5, latency_ms: 52 },
      { fixture_id: "neg-test", pass: false, rank: null, total_results: 2, latency_ms: 15 },
    ],
    timestamp: "2026-06-10T12:00:00.000Z",
  };

  test("includes title and summary line", () => {
    const output = formatReport(report);
    expect(output).toContain("recall@k Evaluation Report");
    expect(output).toContain("Fixtures: 3 | Passed: 2 | Failed: 1");
  });

  test("includes all fixture IDs in table", () => {
    const output = formatReport(report);
    expect(output).toContain("fact-tea");
    expect(output).toContain("pref-music");
    expect(output).toContain("neg-test");
  });

  test("shows pass rate", () => {
    const output = formatReport(report);
    expect(output).toContain("Pass rate: 66.7%");
  });

  test("shows timestamp", () => {
    const output = formatReport(report);
    expect(output).toContain("2026-06-10T12:00:00.000Z");
  });

  test("handles 100% pass rate", () => {
    const perfect: HarnessReport = {
      total: 1,
      passed: 1,
      failed: 0,
      results: [{ fixture_id: "a", pass: true, rank: 1, total_results: 1, latency_ms: 10 }],
      timestamp: "2026-06-10T12:00:00.000Z",
    };
    const output = formatReport(perfect);
    expect(output).toContain("Pass rate: 100.0%");
  });

  test("handles empty report", () => {
    const empty: HarnessReport = {
      total: 0,
      passed: 0,
      failed: 0,
      results: [],
      timestamp: "2026-06-10T12:00:00.000Z",
    };
    const output = formatReport(empty);
    expect(output).toContain("Pass rate: 0.0%");
  });
});
