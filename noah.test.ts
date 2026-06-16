import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockModelChat = mock();
const mockRecall = mock();
const mockDispatchTool = mock();
const mockGetAllTools = mock();

const testConfig = {
  provider: "cloud" as "local" | "cloud",
  cloud: { model: "test-model" },
  ollama: { model: "test-model" },
  maxToolRounds: 3,
  mcpToolTimeoutMs: 15_000,
  maxContextChars: 40_000,
  shortUtteranceThreshold: 5,
};

mock.module("./config", () => ({ config: testConfig }));
mock.module("./logger", () => ({ log: () => {} }));
mock.module("./data-boundary", () => ({
  wrapAsData: () => "No relevant memories found.",
  wrapWebResearchAsData: () => "",
}));
mock.module("./kernel-seam", () => ({
  createKernel: () => ({
    process: async (input: { userMessage: string; memories: unknown[] }) => ({
      processedMessage: input.userMessage,
      processedMemories: input.memories ?? [],
      metadata: { kernel: "passthrough" },
    }),
  }),
}));
mock.module("./model-client", () => ({
  createModelClient: () => ({
    chat: mockModelChat,
    name: "test-model",
    provider: "cloud",
  }),
}));
mock.module("./memory-client", () => ({
  memoryClient: {
    recall: mockRecall,
    get isAvailable() {
      return true;
    },
  },
}));
mock.module("./tool-router", () => ({
  getAllTools: mockGetAllTools,
  dispatchTool: mockDispatchTool,
}));

const { chat } = await import("./noah");

type ChatEvent = { type: string; data: string };

async function collect(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const OK = { content: "Test response.", tool_calls: [] as unknown[], thinking: "" };
const EMPTY_RECALL = { count: 0, signals: {}, totalMs: 0, memories: [] };

beforeEach(() => {
  mockModelChat.mockReset();
  mockRecall.mockReset();
  mockDispatchTool.mockReset();
  mockGetAllTools.mockReset();

  mockModelChat.mockResolvedValue(OK);
  mockRecall.mockResolvedValue(EMPTY_RECALL);
  mockGetAllTools.mockReturnValue([]);
  mockDispatchTool.mockResolvedValue("{}");

  testConfig.maxToolRounds = 3;
  testConfig.maxContextChars = 40_000;
});

describe("agent loop resilience", () => {
  test("yields error event when model throws", async () => {
    mockModelChat.mockRejectedValueOnce(
      new Error("Cloud 503: Service Unavailable"),
    );
    const events = await collect(chat("hello", "err-1", []));
    const err = events.find((e: ChatEvent) => e.type === "error");
    expect(err).toBeDefined();
    expect(err!.data).toContain("503");
  });

  test("yields error event on model timeout", async () => {
    mockModelChat.mockRejectedValueOnce(
      new Error("Request timed out after 60000ms"),
    );
    const events = await collect(chat("hello", "err-2", []));
    const err = events.find((e: ChatEvent) => e.type === "error");
    expect(err).toBeDefined();
    expect(err!.data).toContain("timed out");
  });

  test("continues in degraded mode when recall fails", async () => {
    mockRecall.mockRejectedValueOnce(new Error("MCP connection lost"));
    const events = await collect(chat("hello", "deg-1", []));

    const meta = events.find((e: ChatEvent) => e.type === "metadata");
    expect(meta).toBeDefined();
    expect(JSON.parse(meta!.data).degraded).toBe(true);

    expect(events.some((e: ChatEvent) => e.type === "token")).toBe(true);
    expect(events.some((e: ChatEvent) => e.type === "error")).toBe(false);
  });

  test("handles tool dispatch failure without crashing", async () => {
    mockGetAllTools.mockReturnValue([
      {
        type: "function",
        function: { name: "memory_remember", description: "store", parameters: {} },
      },
    ]);

    mockModelChat
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          { id: "c1", function: { name: "memory_remember", arguments: { content: "test" } } },
        ],
        thinking: "",
      })
      .mockResolvedValueOnce({
        content: "Could not store that.",
        tool_calls: [],
        thinking: "",
      });

    mockDispatchTool.mockRejectedValueOnce(new Error("MCP unavailable"));

    const events = await collect(chat("remember this", "tool-1", []));
    expect(events.some((e: ChatEvent) => e.type === "token")).toBe(true);
    expect(events.some((e: ChatEvent) => e.type === "error")).toBe(false);
  });

  test("forces final round when context exceeds limit", async () => {
    testConfig.maxContextChars = 100;
    const events = await collect(
      chat("hi", "ctx-1", [{ role: "user", content: "x".repeat(200) }]),
    );
    expect(
      events.some(
        (e: ChatEvent) => e.type === "thinking" && e.data.includes("Context limit"),
      ),
    ).toBe(true);
    expect(events.some((e: ChatEvent) => e.type === "token")).toBe(true);
  });

  test("respects maxToolRounds limit", async () => {
    testConfig.maxToolRounds = 2;
    mockGetAllTools.mockReturnValue([
      {
        type: "function",
        function: { name: "memory_recall", description: "search", parameters: {} },
      },
    ]);
    mockDispatchTool.mockResolvedValue(
      JSON.stringify({ count: 0, memories: [] }),
    );

    let callCount = 0;
    mockModelChat.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return {
          content: "",
          tool_calls: [
            { id: `c${callCount}`, function: { name: "memory_recall", arguments: { query: "test" } } },
          ],
          thinking: "",
        };
      }
      return { content: "Done after rounds.", tool_calls: [], thinking: "" };
    });

    const events = await collect(chat("test", "rounds-1", []));
    expect(
      events.some(
        (e: ChatEvent) => e.type === "token" && e.data.includes("Done after rounds"),
      ),
    ).toBe(true);
    expect(callCount).toBe(3);
  });

  test("emits metadata, token, and done events on success", async () => {
    const events = await collect(chat("hello", "ok-1", []));
    const types = events.map((e: ChatEvent) => e.type);
    expect(types).toContain("metadata");
    expect(types).toContain("token");
    expect(types).toContain("done");

    const done = JSON.parse(events.find((e: ChatEvent) => e.type === "done")!.data);
    expect(done.provenance.degraded).toBe(false);
    expect(done.provenance.model).toBe("cloud");
  });

  test("malformed tool-call arguments do not crash the turn (#3)", async () => {
    mockGetAllTools.mockReturnValue([
      {
        type: "function",
        function: { name: "memory_recall", description: "search", parameters: {} },
      },
    ]);
    mockModelChat
      .mockResolvedValueOnce({
        content: "",
        // arguments is a malformed JSON string (missing closing brace) — this is
        // the shape that previously threw OUTSIDE the per-tool try/catch.
        tool_calls: [
          { id: "c1", function: { name: "memory_recall", arguments: '{"query": "values"' } },
        ],
        thinking: "",
      })
      .mockResolvedValueOnce({ content: "Here is what I found.", tool_calls: [], thinking: "" });

    const events = await collect(chat("search your memory for values", "argerr-1", []));
    expect(events.some((e: ChatEvent) => e.type === "error")).toBe(false);
    expect(events.some((e: ChatEvent) => e.type === "token")).toBe(true);
    // The unparseable call must be turned into a tool-error result, not dispatched.
    expect(mockDispatchTool).not.toHaveBeenCalled();
  });

  test("forces a final answer when the model ends on tool-only output (#4)", async () => {
    testConfig.maxToolRounds = 1; // round 0 has tools; round 1 (final) does not
    mockGetAllTools.mockReturnValue([
      {
        type: "function",
        function: { name: "memory_recall", description: "search", parameters: {} },
      },
    ]);
    mockDispatchTool.mockResolvedValue(JSON.stringify({ count: 0, memories: [] }));

    let n = 0;
    mockModelChat.mockImplementation(async () => {
      n++;
      if (n === 1)
        return {
          content: "",
          tool_calls: [{ id: "c1", function: { name: "memory_recall", arguments: { query: "x" } } }],
          thinking: "",
        };
      if (n === 2)
        // final round: tools disabled, but the model still emits a tool call + empty content
        return {
          content: "",
          tool_calls: [{ id: "c2", function: { name: "memory_recall", arguments: { query: "y" } } }],
          thinking: "",
        };
      return { content: "Final forced answer.", tool_calls: [], thinking: "" };
    });

    const events = await collect(chat("what are my values", "final-1", []));
    const token = events.find((e: ChatEvent) => e.type === "token");
    expect(token).toBeDefined();
    expect(token!.data).toContain("Final forced answer.");
    expect(events.some((e: ChatEvent) => e.type === "error")).toBe(false);
  });

  test("maps raw provider errors to friendly text (keeps status code)", async () => {
    mockModelChat.mockRejectedValueOnce(new Error("Cloud 401: {\"error\":\"bad key\"}"));
    const events = await collect(chat("hello", "fe-1", []));
    const err = events.find((e: ChatEvent) => e.type === "error");
    expect(err).toBeDefined();
    expect(err!.data).toContain("authentication");
    expect(err!.data).toContain("401");
    // raw JSON body must not leak to the user
    expect(err!.data).not.toContain("bad key");
  });
});
