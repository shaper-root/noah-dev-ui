// SSE wire-format helpers for Noah's /api/chat stream.
//
// The `data:` field of an SSE event must never contain a bare newline: a blank
// line terminates the event, and any line not prefixed with "data: " is dropped
// by the consumer. Model output routinely contains newlines (multi-paragraph
// answers, numbered lists), so free-text payloads are JSON-encoded by the caller
// before they reach the wire — that keeps each event a single, framing-safe
// `data:` line. This encoder is *additionally* newline-safe: it prefixes every
// line of `data` with "data: ", so even a raw multi-line payload is framed
// correctly per the SSE spec. Defense in depth against the framing bug that
// silently truncated multi-line responses on the Noah->Rootworks hop.

export type SSEEventName =
  | "conversation_id"
  | "token"
  | "thinking"
  | "tool_call"
  | "metadata"
  | "error"
  | "done";

/** Encode a single SSE event. `data` is the final string payload (already
 * JSON-encoded by the caller for free-text events). */
export function formatSSE(event: SSEEventName, data: string): string {
  const dataLines = data
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  return `event: ${event}\n${dataLines}\n\n`;
}

/** Encode an SSE comment line (used for keepalives). */
export function formatSSEComment(text: string): string {
  return `: ${text}\n\n`;
}
