import { describe, test, expect, mock } from "bun:test";

// Isolated regression test for the dispatchTool defensive wrapper.
//
// Guarantee under test: dispatchTool must NEVER throw out — any tool
// implementation failure (network/fetch error, MCP reject, future tool) is
// converted to a structured error STRING, so a tool failure can't crash the
// SSE chat stream. We mock ./web-research so webResearch() throws, then assert
// dispatchTool returns an error string instead of rejecting.
//
// RUN IN ISOLATION: `bun test tool-router-dispatch.test.ts`. bun's mock.module
// is process-global (it would shadow the real ./web-research in a whole-suite
// run), matching the repo's existing per-file test convention.
mock.module("./web-research", () => ({
  webResearch: async () => {
    throw new Error("simulated network explosion");
  },
}));

const { dispatchTool } = await import("./tool-router");

describe("dispatchTool defensive wrapper", () => {
  test("a throwing tool impl yields an error STRING, never throws/rejects", async () => {
    let result = "";
    let threw = false;
    try {
      result = await dispatchTool({
        id: "c1",
        function: { name: "web_research", arguments: { query: "anything" } },
      });
    } catch (e) {
      threw = true;
      result = e instanceof Error ? e.message : String(e);
    }
    expect(threw).toBe(false); // the whole point: it must not propagate
    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result) as { error?: string };
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("web_research");
    expect(parsed.error).toContain("simulated network explosion");
  });

  test("unknown tool returns an error string, not a throw", async () => {
    const r = await dispatchTool({
      id: "c2",
      function: { name: "no_such_tool", arguments: {} },
    });
    expect(JSON.parse(r).error).toContain("Unknown tool");
  });
});
