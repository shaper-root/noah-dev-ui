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
  // Required by the real loadSelfKnowledge module (which we no longer mock).
  // Disabled here so the loader returns passthrough cleanly without touching disk.
  vault: { enabled: false, path: "" },
  // Required by vault-bridge — disabled here so the real module returns
  // early and doesn't touch the filesystem or memory.db during tests.
  vaultBridge: { enabled: false, deviceId: "test" },
  memory: { userId: "test", sqlitePath: "", memoryApiDir: "" },
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
  // Derive memory-only tools from whatever getAllTools is mocked to return —
  // keeps tests honest about the Phase 2B carve-out (memory tools survive the
  // context guard).
  getMemoryTools: () =>
    (mockGetAllTools() as Array<{ function: { name: string } }>).filter((t) =>
      t.function.name.startsWith("memory_"),
    ),
  dispatchTool: mockDispatchTool,
}));
mock.module("./kernel", () => ({
  loadKernel: () => ({
    active: false,
    tier: "none",
    text: "",
    version: "none",
    tokenEstimate: 0,
    source: "passthrough",
  }),
}));
// Self-knowledge is NOT mocked: testConfig.vault.enabled=false makes the real
// loader return passthrough deterministically, and not mocking here lets
// self-knowledge.test.ts exercise the real module without bun's process-global
// mock.module shadowing it.
// ./skill-detect is NOT mocked: the real module has no external deps,
// no tests in this file assert on detectSkills output, and bun's
// mock.module is process-global — a mock here leaks into
// skill-detect.test.ts and breaks its assertions on the real
// pattern-matching logic.

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

  test("does not leak raw tool-call JSON when the model text-emits it on the final round", async () => {
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
        // FINAL round, tools disabled: model TEXT-EMITS a tool call as JSON in
        // content (qwen3.5 does this). It must NOT be shown to the user as prose.
        return { content: '{"name":"memory_recall","arguments":{"query":"values"}}', tool_calls: [], thinking: "" };
      return { content: "Here is a real answer.", tool_calls: [], thinking: "" };
    });

    const events = await collect(chat("what are my values", "finaljson-1", []));
    const token = events.find((e: ChatEvent) => e.type === "token");
    expect(token).toBeDefined();
    expect(token!.data).toContain("Here is a real answer.");
    expect(token!.data).not.toContain('"name"'); // raw tool-call JSON must not leak
    expect(events.some((e: ChatEvent) => e.type === "error")).toBe(false);
  });
});

describe("Phase 2: memory store verification + provenance", () => {
  test("detectExplicitMemoryIntent recognizes common phrasings", async () => {
    const { detectExplicitMemoryIntent } = await import("./noah");
    expect(detectExplicitMemoryIntent("remember the books on my desk")).toBe(true);
    expect(detectExplicitMemoryIntent("Please remember that I prefer dark mode")).toBe(true);
    expect(detectExplicitMemoryIntent("Save this for later")).toBe(true);
    expect(detectExplicitMemoryIntent("Don't forget the meeting Tuesday")).toBe(true);
    expect(detectExplicitMemoryIntent("Make a note: schema changes Q3")).toBe(true);
    expect(detectExplicitMemoryIntent("memorize my address")).toBe(true);
    expect(detectExplicitMemoryIntent("file that away")).toBe(true);
    expect(detectExplicitMemoryIntent("write this down")).toBe(true);

    // Negative cases — these should NOT trigger explicit intent.
    expect(detectExplicitMemoryIntent("Hello there")).toBe(false);
    expect(detectExplicitMemoryIntent("What's the weather like?")).toBe(false);
    expect(detectExplicitMemoryIntent("I want to talk about my project")).toBe(false);
  });

  test("metadata event carries explicit_memory_intent flag", async () => {
    const events = await collect(chat("remember the books on my desk", "explicit-1", []));
    const meta = events.find((e: ChatEvent) => e.type === "metadata");
    expect(meta).toBeDefined();
    expect(JSON.parse(meta!.data).explicit_memory_intent).toBe(true);

    const events2 = await collect(chat("hello", "explicit-2", []));
    const meta2 = events2.find((e: ChatEvent) => e.type === "metadata");
    expect(JSON.parse(meta2!.data).explicit_memory_intent).toBe(false);
  });

  test("explicit intent injects explicit=true into memory_remember args", async () => {
    mockGetAllTools.mockReturnValue([
      {
        type: "function",
        function: { name: "memory_remember", description: "store", parameters: {} },
      },
    ]);
    mockDispatchTool.mockResolvedValue(
      JSON.stringify({ stored: true, id: "uuid-1", confidence: 0.9, embedded: true, explicit: true }),
    );

    mockModelChat
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "c1",
            function: {
              name: "memory_remember",
              arguments: { content: "books are on the desk", type: "fact" },
            },
          },
        ],
        thinking: "",
      })
      .mockResolvedValueOnce({ content: "Got it.", tool_calls: [], thinking: "" });

    await collect(chat("remember the books on my desk", "explicit-3", []));
    // The dispatched call must carry explicit=true even though the model did not
    // emit it — noah.ts injected it because the user message tripped intent.
    const dispatchedArgs = (mockDispatchTool.mock.calls[0]?.[0] as {
      function: { arguments: Record<string, unknown> };
    })?.function.arguments;
    expect(dispatchedArgs.explicit).toBe(true);
  });

  test("non-explicit intent does NOT inject explicit=true", async () => {
    mockGetAllTools.mockReturnValue([
      {
        type: "function",
        function: { name: "memory_remember", description: "store", parameters: {} },
      },
    ]);
    mockDispatchTool.mockResolvedValue(
      JSON.stringify({ stored: true, id: "uuid-2", confidence: 0.9, embedded: true }),
    );

    mockModelChat
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "c1",
            function: { name: "memory_remember", arguments: { content: "user said hi" } },
          },
        ],
        thinking: "",
      })
      .mockResolvedValueOnce({ content: "Hi.", tool_calls: [], thinking: "" });

    await collect(chat("hi there", "not-explicit", []));
    const dispatchedArgs = (mockDispatchTool.mock.calls[0]?.[0] as {
      function: { arguments: Record<string, unknown> };
    })?.function.arguments;
    // cso H1 fix: noah.ts now FORCE-SETS explicit to the host-side intent
    // value (true OR false), overwriting any model-supplied value. So the
    // dispatched call carries explicit:false (not undefined) when intent
    // wasn't detected — the security property is that the model can never
    // grant itself the bypass.
    expect(dispatchedArgs.explicit).toBe(false);
  });

  test("Phase 2D / cso H1: model-supplied explicit:true is FORCE-OVERWRITTEN by host-side intent", async () => {
    mockGetAllTools.mockReturnValue([
      {
        type: "function",
        function: { name: "memory_remember", description: "store", parameters: {} },
      },
    ]);
    mockDispatchTool.mockResolvedValue(
      JSON.stringify({ stored: true, id: "uuid-3", confidence: 0.9, embedded: true }),
    );

    // The model tries to self-grant the gate bypass — emits explicit:true even
    // though the user did NOT express store intent.
    mockModelChat
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "c1",
            function: {
              name: "memory_remember",
              arguments: { content: "smuggled fact", explicit: true },
            },
          },
        ],
        thinking: "",
      })
      .mockResolvedValueOnce({ content: "ok.", tool_calls: [], thinking: "" });

    // User message has no explicit-store intent.
    await collect(chat("hi there", "h1-test", []));
    const dispatchedArgs = (mockDispatchTool.mock.calls[0]?.[0] as {
      function: { arguments: Record<string, unknown> };
    })?.function.arguments;
    // The model's explicit:true MUST be overwritten to false.
    expect(dispatchedArgs.explicit).toBe(false);
  });

  test("done event surfaces memory store outcomes (both stored and failed)", async () => {
    mockGetAllTools.mockReturnValue([
      {
        type: "function",
        function: { name: "memory_remember", description: "store", parameters: {} },
      },
    ]);
    // First call: success. Second call: failure (e.g., MCP timeout).
    mockDispatchTool
      .mockResolvedValueOnce(
        JSON.stringify({ stored: true, id: "uuid-ok", confidence: 0.9, embedded: true }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          stored: false,
          kind: "timeout",
          reason: "memory_remember timed out after 15000ms",
        }),
      );

    mockModelChat
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          { id: "c1", function: { name: "memory_remember", arguments: { content: "fact one" } } },
          { id: "c2", function: { name: "memory_remember", arguments: { content: "fact two" } } },
        ],
        thinking: "",
      })
      .mockResolvedValueOnce({ content: "Tried to store two.", tool_calls: [], thinking: "" });

    const events = await collect(chat("remember these two facts", "verify-1", []));
    const done = JSON.parse(events.find((e: ChatEvent) => e.type === "done")!.data);

    expect(done.memory_stores).toHaveLength(2);
    expect(done.memory_stores[0].stored).toBe(true);
    expect(done.memory_stores[0].id).toBe("uuid-ok");
    expect(done.memory_stores[1].stored).toBe(false);
    expect(done.memory_stores[1].kind).toBe("timeout");
    expect(done.explicit_memory_intent).toBe(true);
  });

  test("Phase 3B: expandVagueQuery rewrites identity queries with keyword anchors", async () => {
    const { expandVagueQuery } = await import("./noah");
    expect(expandVagueQuery("what do you know about me?")).toContain("identity");
    expect(expandVagueQuery("tell me about myself")).toContain("identity");
    expect(expandVagueQuery("Who am I")).toContain("identity");
    expect(expandVagueQuery("what are my values?")).toContain("CARE");
    expect(expandVagueQuery("what do I prefer")).toContain("preference");

    // Specific queries pass through unchanged.
    expect(expandVagueQuery("what books are on my desk?")).toBe(
      "what books are on my desk?",
    );
    expect(expandVagueQuery("hello")).toBe("hello");
  });

  test("Phase 3C: detectExplicitRecallIntent recognizes memory-read questions", async () => {
    const { detectExplicitRecallIntent } = await import("./noah");
    expect(detectExplicitRecallIntent("what do I prefer")).toBe(true);
    expect(detectExplicitRecallIntent("what are my values")).toBe(true);
    expect(detectExplicitRecallIntent("tell me about my projects")).toBe(true);
    expect(detectExplicitRecallIntent("do you remember the books?")).toBe(true);
    expect(detectExplicitRecallIntent("did I mention the meeting?")).toBe(true);
    expect(detectExplicitRecallIntent("search my memory for X")).toBe(true);

    expect(detectExplicitRecallIntent("hello")).toBe(false);
    expect(detectExplicitRecallIntent("how is the weather")).toBe(false);
  });

  test("Phase 3B+C: vague query expansion AND topK boost both flow into recall", async () => {
    let capturedQuery = "";
    let capturedTopK: number | undefined;
    mockRecall.mockImplementation(async (q: string, opts?: { topK?: number }) => {
      capturedQuery = q;
      capturedTopK = opts?.topK;
      return EMPTY_RECALL;
    });

    await collect(chat("what do you know about me?", "expand-1", []));
    // Expansion appended identity keywords.
    expect(capturedQuery).toContain("identity");
    // Vague identity gets the highest topK boost (30).
    expect(capturedTopK).toBe(30);

    // Reset and re-test for plain explicit recall (non-vague) → topK 20.
    // Pass a non-empty history so we're past the first-message-of-session
    // override (which would otherwise force topK=30 — Phase 6A).
    mockRecall.mockClear();
    capturedQuery = "";
    capturedTopK = undefined;
    mockRecall.mockImplementation(async (q: string, opts?: { topK?: number }) => {
      capturedQuery = q;
      capturedTopK = opts?.topK;
      return EMPTY_RECALL;
    });
    await collect(
      chat("tell me about the noah project", "expand-2", [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]),
    );
    expect(capturedTopK).toBe(20);

    // Ambient (no explicit recall, not vague, not first message) → topK 10.
    mockRecall.mockClear();
    capturedTopK = undefined;
    mockRecall.mockImplementation(async (q: string, opts?: { topK?: number }) => {
      capturedTopK = opts?.topK;
      return EMPTY_RECALL;
    });
    await collect(
      chat("I had a great morning", "expand-3", [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]),
    );
    expect(capturedTopK).toBe(10);
  });

  test("Phase 6A: first message of session uses topK=30 even on a non-vague query", async () => {
    let capturedTopK: number | undefined;
    mockRecall.mockImplementation(async (_q: string, opts?: { topK?: number }) => {
      capturedTopK = opts?.topK;
      return EMPTY_RECALL;
    });

    // Empty history === first message of session. Mundane query — without 6A
    // this would be topK=10.
    await collect(chat("hey", "first-1", []));
    expect(capturedTopK).toBe(30);
  });

  test("Phase 6A: session_start_brief flag fires only when memory has something to brief on", async () => {
    // History empty AND recall returns one memory → flag true.
    mockRecall.mockResolvedValueOnce({
      count: 1,
      signals: {},
      totalMs: 0,
      memories: [
        {
          id: "m1",
          content: "Root's daughter is Luna.",
          type: "fact",
          category: "stable",
          scope: "family",
          source: "seed",
          entities: ["Luna"],
          keywords: [],
          confidence: 1,
          created_at: "2025-01-01T00:00:00Z",
          score: 0.9,
        },
      ],
    });
    let events = await collect(chat("hi", "first-2", []));
    let meta = JSON.parse(events.find((e: ChatEvent) => e.type === "metadata")!.data);
    expect(meta.session_start_brief).toBe(true);

    // Same first message but recall returns nothing → flag false (don't force
    // a confabulated "where we left off").
    mockRecall.mockResolvedValueOnce(EMPTY_RECALL);
    events = await collect(chat("hi", "first-3", []));
    meta = JSON.parse(events.find((e: ChatEvent) => e.type === "metadata")!.data);
    expect(meta.session_start_brief).toBe(false);

    // Non-first message → flag false even if memory is rich.
    mockRecall.mockResolvedValueOnce({
      count: 1,
      signals: {},
      totalMs: 0,
      memories: [
        {
          id: "m1",
          content: "x",
          type: "fact",
          category: "stable",
          scope: "x",
          source: "seed",
          entities: [],
          keywords: [],
          confidence: 1,
          created_at: "2025-01-01T00:00:00Z",
          score: 1,
        },
      ],
    });
    events = await collect(
      chat("hi", "non-first", [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "ok" },
      ]),
    );
    meta = JSON.parse(events.find((e: ChatEvent) => e.type === "metadata")!.data);
    expect(meta.session_start_brief).toBe(false);
  });

  test("memory tools remain available when context exceeds limit (Phase 2B carve-out)", async () => {
    // Force context-exceeded on round 0 so tools would normally be dropped.
    testConfig.maxContextChars = 100;

    mockGetAllTools.mockReturnValue([
      {
        type: "function",
        function: { name: "memory_remember", description: "store", parameters: {} },
      },
      {
        type: "function",
        function: { name: "web_research", description: "search", parameters: {} },
      },
    ]);
    mockDispatchTool.mockResolvedValue(
      JSON.stringify({ stored: true, id: "uuid-late", confidence: 0.9, embedded: true }),
    );

    mockModelChat
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          { id: "c1", function: { name: "memory_remember", arguments: { content: "late fact" } } },
        ],
        thinking: "",
      })
      .mockResolvedValueOnce({ content: "Stored under pressure.", tool_calls: [], thinking: "" });

    const events = await collect(
      chat("remember this", "carveout-1", [
        { role: "user", content: "x".repeat(500) },
      ]),
    );

    // The memory_remember tool MUST have dispatched, even though context exceeded.
    expect(mockDispatchTool).toHaveBeenCalled();
    const done = JSON.parse(events.find((e: ChatEvent) => e.type === "done")!.data);
    expect(done.memory_stores[0].stored).toBe(true);
  });
});
