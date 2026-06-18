import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { config } from "./config";
import { webResearch } from "./web-research";

// This file tests the STUB provider specifically. The provider is read live
// from config.webSearch.provider, which the environment may set to "ddg"
// (NOAH_WEB_SEARCH_PROVIDER=ddg) — that would make webResearch hit the real
// network and return live results. Pin it to "stub" for the duration of this
// file and restore it after, so the test is deterministic and offline.
const realProvider = config.webSearch.provider;
beforeAll(() => {
  config.webSearch.provider = "stub";
});
afterAll(() => {
  config.webSearch.provider = realProvider;
});

describe("webResearch (stub provider)", () => {
  test("returns empty results with correct shape", async () => {
    const result = await webResearch("test query");
    expect(result.query).toBe("test query");
    expect(result.results).toEqual([]);
    expect(result.source).toBe("web_research");
  });
});
