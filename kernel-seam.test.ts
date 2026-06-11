import { describe, test, expect } from "bun:test";
import { PassthroughKernel, createKernel } from "./kernel-seam";
import type { RecalledMemory } from "./memory-client";

function makeMem(content: string): RecalledMemory {
  return {
    id: "k-1",
    content,
    type: "fact",
    category: "stable",
    scope: "test",
    source: "conversation",
    entities: [],
    keywords: [],
    confidence: 0.85,
    created_at: "2025-06-01T00:00:00Z",
    score: 0.9,
  };
}

describe("PassthroughKernel", () => {
  const kernel = new PassthroughKernel();

  test("process returns input unchanged", async () => {
    const input = {
      userMessage: "Hello Noah",
      memories: [makeMem("Root likes tea")],
      conversationHistory: [{ role: "user", content: "Hi" }],
    };

    const output = await kernel.process(input);

    expect(output.processedMessage).toBe("Hello Noah");
    expect(output.processedMemories).toEqual(input.memories);
    expect(output.metadata.kernel).toBe("passthrough");
  });

  test("health returns ok", async () => {
    const h = await kernel.health();
    expect(h.ok).toBe(true);
    expect(h.version).toBe("none");
  });
});

describe("createKernel", () => {
  test("returns a PassthroughKernel instance", () => {
    const kernel = createKernel();
    expect(kernel).toBeInstanceOf(PassthroughKernel);
  });
});
