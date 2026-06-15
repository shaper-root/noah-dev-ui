import { describe, test, expect } from "bun:test";
import { formatSSE, formatSSEComment } from "./sse";

// Regression tests for root cause #1: multi-line model output broke SSE framing
// on the Noah->Rootworks hop because the data field contained bare newlines.

describe("SSE encoder (RC1 newline safety)", () => {
  test("single-line JSON payload frames as exactly one event", () => {
    expect(formatSSE("token", '"hello"')).toBe('event: token\ndata: "hello"\n\n');
  });

  test("JSON-encoded multi-line text never breaks framing and round-trips", () => {
    const original = "Three things:\n\n1. A\n2. B\n3. C";
    const wire = formatSSE("token", JSON.stringify(original));

    // The only blank-line boundary is the terminator at the very end.
    expect(wire.endsWith("\n\n")).toBe(true);
    expect(wire.slice(0, -2).includes("\n\n")).toBe(false);

    // A single-data-line consumer recovers the full text via JSON.parse.
    const dataLine = wire.slice(0, -2).split("\n").find((l) => l.startsWith("data: "));
    expect(dataLine).toBeDefined();
    expect(JSON.parse(dataLine!.slice(6))).toBe(original);
  });

  test("raw multi-line data stays newline-safe (every line prefixed)", () => {
    // Defense in depth: even a non-JSON multi-line payload is framed per spec.
    const wire = formatSSE("thinking", "a\nb\nc");
    expect(wire).toBe("event: thinking\ndata: a\ndata: b\ndata: c\n\n");
    expect(wire.slice(0, -2).includes("\n\n")).toBe(false);
  });

  test("keepalive comment is well-formed and skippable", () => {
    const c = formatSSEComment("keepalive");
    expect(c).toBe(": keepalive\n\n");
    expect(c.startsWith(":")).toBe(true);
  });
});
