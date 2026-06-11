import { describe, test, expect } from "bun:test";
import { webResearch } from "./web-research";

describe("webResearch (stub provider)", () => {
  test("returns empty results with correct shape", async () => {
    const result = await webResearch("test query");
    expect(result.query).toBe("test query");
    expect(result.results).toEqual([]);
    expect(result.source).toBe("web_research");
  });
});
