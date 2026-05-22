/**
 * Noah conversation orchestrator — mirrors HA's conversation.py logic.
 * Handles memory retrieval, Ollama chat, tool-call loop, and streaming.
 */

const OLLAMA_URL = "http://127.0.0.1:11434";
const MEMORY_URL = "http://127.0.0.1:6789";
const MODEL = "qwen3.5:4b";
const NUM_CTX = 12288;
const MAX_TOOL_ROUNDS = 5;
const SHORT_UTTERANCE_THRESHOLD = 5;
const MEMORY_PROBE_TIMEOUT = 2000;
const MEMORY_HEALTH_RECHECK_MS = 60_000;
const RETRIEVE_RETRY_ATTEMPTS = 2;
const RETRIEVE_RETRY_DELAY_MS = 1500;
const OLLAMA_TIMEOUT_MS = 120_000; // 2 min timeout for Ollama calls

// Memory resilience state
let memoryAvailable = true;
let memoryLastFail = 0;

// Session corrections per conversation
const sessionCorrections = new Map<string, string[]>();

// Tool definitions (matches HA's const.py MEMORY_TOOLS)
const MEMORY_TOOLS = [
  {
    type: "function",
    function: {
      name: "memory_store",
      description:
        "Store a memory. Use whenever Root shares preferences, facts, " +
        "commitments, corrections, or knowledge worth remembering. " +
        "Don't ask — just store it.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "A factual third-person statement about Root. " +
              "Example: if Root says 'I like Earl Grey', store " +
              "'Root likes Earl Grey tea.' Never reverse subject/object.",
          },
          type: {
            type: "string",
            enum: ["fact", "preference", "commitment", "correction"],
            description:
              "fact: general info. preference: likes/dislikes. " +
              "commitment: task with deadline. correction: mistake + right answer.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Freeform tags for filtering.",
          },
          freshness: {
            type: "string",
            enum: ["static", "semi_stable", "transient", "commitment"],
            description:
              "static: permanent. semi_stable: may change. " +
              "transient: changes fast. commitment: has deadline.",
          },
          confidence: {
            type: "number",
            description: "1.0=directly stated, 0.7=inferred, 0.5=uncertain",
          },
          due_date: {
            type: "string",
            description: "ISO 8601 date. For commitments only.",
          },
        },
        required: ["content", "type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_forget",
      description:
        "Permanently delete a memory. Only use when Root explicitly asks to forget something.",
      parameters: {
        type: "object",
        properties: {
          memory_ids: {
            type: "array",
            items: { type: "string" },
            description: "IDs of memories to delete.",
          },
          confirm: {
            type: "boolean",
            description: "Must be true.",
          },
        },
        required: ["memory_ids", "confirm"],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are Noah — a private, locally-hosted AI home assistant for Root (Craig) \
and his family. You run entirely on local hardware. No cloud, no telemetry, \
no corporate dependency. You exist to help this household thrive.

[DEV MODE — this conversation is for testing and feedback]

PERSONALITY
Warm but never bubbly. Dry British wit — think the helpful friend who's \
quietly brilliant and slightly sardonic. You care deeply but show it through \
competence and attention, not effusion. You say "rather" and "I suspect" \
more than "awesome" and "absolutely." When Root asks something dumb, you \
answer kindly but don't pretend it wasn't dumb. When Root does something \
well, you acknowledge it simply. You don't gush.

Direct. No padding. If the answer is short, the response is short. If Root \
needs pushback, give it respectfully but clearly — you are a principled \
partner, not a servant.

Curious. When something doesn't add up, ask. When you don't know, say so \
— "I don't have that" is always better than a guess.

VALUES — CARE FRAMEWORK
Every response must uphold these four values. They are constraints, not \
guidelines.

- Compassion: Thoughtful and kind. Never dismissive, harsh, or patronizing.
- Accountability: Track commitments, follow through, own failures.
- Education: Help Root understand, not just act. Offer the "why" when useful.
- Resourcefulness: Make the best of what's available. Don't suggest impractical solutions.

EARTHSEED PRINCIPLE
"All that you touch you Change. All that you Change changes you."
You are a learning system. Every interaction should make the next one \
better. Store what matters. Correct what's wrong. Don't fail the same way twice.

RELIABILITY RULES — NON-NEGOTIABLE

1. NEVER guess. "I don't have that" is always acceptable. Fabrication is never acceptable.
2. ALWAYS check memory before saying you don't know. If memory returns \
nothing, say so. If it returns something, use it.
3. For ANY time-sensitive information (date, time, weather, calendar, \
scores), say you don't have access to live data in dev mode.
4. Source-tag internally: [MEMORY], [HA_STATE], [KNOWLEDGE] (training data, \
lower confidence), or [UNSURE]. Don't show tags to Root — reason with them.
5. When Root expresses a preference, IMMEDIATELY store it via memory_store \
as type: preference. Apply from that moment forward.
6. When Root makes a commitment or asks you to do/remind something, \
IMMEDIATELY store it via memory_store as type: commitment with a due date. \
If no date given, ask.
7. When corrected, acknowledge, store the correction as type: correction, \
apply immediately. Don't over-explain why you were wrong.

TOOL USAGE
- memory_store: When Root shares info worth remembering, expresses a \
preference, or makes a commitment. Store FIRST, before writing response text.
- memory_forget: Only on explicit Root request.
- Store as third-person factual statement. "I like X" → store "Root likes X." \
Never reverse subject/object.

FORMATTING
- Concise. No bullet points unless content genuinely requires them.
- Match Root's energy. Three-word question = short answer.
- Natural prose. Conversation, not report.

CURRENT STATE
Dev mode — no Home Assistant state available. Current time provided in user context.`;

// --- Memory API ---

async function memoryRetrieve(
  query: string,
  limit = 5
): Promise<Array<Record<string, unknown>>> {
  const now = Date.now();

  // Short-circuit when server is known-down
  if (!memoryAvailable) {
    if (now - memoryLastFail < MEMORY_HEALTH_RECHECK_MS) {
      return [];
    }
    // Probe with short timeout
    try {
      const resp = await fetch(`${MEMORY_URL}/api/retrieve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(MEMORY_PROBE_TIMEOUT),
      });
      if (resp.ok) {
        memoryAvailable = true;
        console.log("[noah] Memory server back online");
        return await resp.json();
      }
    } catch {
      memoryLastFail = now;
      return [];
    }
  }

  for (let attempt = 0; attempt < RETRIEVE_RETRY_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(`${MEMORY_URL}/api/retrieve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit }),
      });

      if (resp.status === 503) {
        const body = await resp.json();
        const delay = (body.retry_after_ms || 3000) / 1000;
        if (attempt < RETRIEVE_RETRY_ATTEMPTS - 1) {
          console.log(`[noah] Memory warming up (503) — retrying in ${delay}s`);
          await new Promise((r) => setTimeout(r, delay * 1000));
          continue;
        }
        throw new Error("503 warming up");
      }

      if (!resp.ok) throw new Error(`Memory retrieve failed: ${resp.status}`);
      memoryAvailable = true;
      return await resp.json();
    } catch (err) {
      if (attempt >= RETRIEVE_RETRY_ATTEMPTS - 1) {
        console.warn(`[noah] Memory retrieve failed after ${RETRIEVE_RETRY_ATTEMPTS} attempts:`, err);
        memoryAvailable = false;
        memoryLastFail = Date.now();
      } else {
        await new Promise((r) => setTimeout(r, RETRIEVE_RETRY_DELAY_MS));
      }
    }
  }
  return [];
}

async function memoryToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const endpoint = name === "memory_store" ? "/api/store" : "/api/forget";
  try {
    const resp = await fetch(`${MEMORY_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    return await resp.json();
  } catch (err) {
    console.error(`[noah] ${name} failed:`, err);
    return { success: false, error: String(err) };
  }
}

// --- Prompt Building ---

function buildPreferenceBlock(memories: Array<Record<string, unknown>>): string {
  if (!memories.length) return "No relevant memories found.";

  return memories
    .map((mem) => {
      const content = mem.content as string;
      const memType = mem.type as string;
      const confidence = (mem.confidence as number) ?? 1.0;
      const stale = mem.possibly_stale as boolean;
      let createdStr = "unknown date";
      try {
        const dt = new Date(mem.created_at as string);
        createdStr = dt.toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        });
      } catch {
        /* keep default */
      }

      let line = `- [${memType}] ${content} (learned ${createdStr}`;
      if (confidence < 1.0) line += `, confidence: ${Math.round(confidence * 100)}%`;
      if (stale) line += ", POSSIBLY STALE";
      line += ")";
      return line;
    })
    .join("\n");
}

function buildCorrectionsBlock(conversationId: string): string {
  const corrections = sessionCorrections.get(conversationId) || [];
  if (!corrections.length) return "No corrections this session.";
  return corrections.map((c) => `- ${c}`).join("\n");
}

function buildRetrievalQuery(
  userMessage: string,
  history: Array<{ role: string; content: string }>
): string {
  const words = userMessage.trim().split(/\s+/);
  if (words.length >= SHORT_UTTERANCE_THRESHOLD) return userMessage;

  // Short utterance — use recent context
  const recentUserMessages = history
    .filter((m) => m.role === "user")
    .slice(-3)
    .map((m) => m.content);
  recentUserMessages.push(userMessage);
  return recentUserMessages.join(" ");
}

// --- Tool Call Parsing ---

function extractJsonObject(text: string, start: number): string | null {
  if (start >= text.length || text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"' && !escape) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

function parseToolCalls(message: Record<string, unknown>): ToolCall[] {
  // Format 1: structured tool_calls field (Ollama native)
  const toolCalls = message.tool_calls as ToolCall[] | undefined;
  if (toolCalls && toolCalls.length > 0) {
    console.log(`[noah] Tool calls in structured field: ${toolCalls.length}`);
    return toolCalls;
  }

  // Format 2: JSON embedded in content (Qwen sometimes does this)
  const content = (message.content as string) || "";
  if (!content) return [];

  const parsed: ToolCall[] = [];
  const pattern = /"name"\s*:\s*"(memory_store|memory_forget)"/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    let pos = match.index;
    while (pos > 0 && content[pos] !== "{") pos--;
    if (content[pos] === "{") {
      const objStr = extractJsonObject(content, pos);
      if (objStr) {
        try {
          const obj = JSON.parse(objStr);
          const name = obj.name || "";
          const args = obj.arguments || obj.parameters || {};
          if (name && typeof args === "object") {
            parsed.push({ function: { name, arguments: args } });
          }
        } catch {
          continue;
        }
      }
    }
  }

  if (parsed.length > 0) {
    console.log(`[noah] Tool calls parsed from content (fallback): ${parsed.length}`);
  }
  return parsed;
}

function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/\/no_think\s*/g, "")
    .trim();
}

// --- SSE Event Types ---

export interface ChatEvent {
  type: "token" | "thinking" | "done" | "error" | "tool_call" | "metadata";
  data: string;
}

// --- Main Chat Function ---

export async function* chat(
  userMessage: string,
  conversationId: string,
  history: Array<{ role: string; content: string }>
): AsyncGenerator<ChatEvent> {
  const startTime = Date.now();

  // 1. Build retrieval query
  const retrievalQuery = buildRetrievalQuery(userMessage, history);
  console.log(`[noah] Retrieval query: "${retrievalQuery.slice(0, 100)}"`);

  // 2. Retrieve memories
  const memories = await memoryRetrieve(retrievalQuery);
  const retrieveMs = Date.now() - startTime;
  console.log(`[noah] Retrieved ${memories.length} memories in ${retrieveMs}ms (available: ${memoryAvailable})`);

  // 3. Build context blocks
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const preferenceBlock = buildPreferenceBlock(memories);
  const correctionsBlock = buildCorrectionsBlock(conversationId);

  // 4. Augment user message with memory context (near the query, not system prompt)
  const userContext = `\n[MEMORY]\n${preferenceBlock}\n\n[SESSION CORRECTIONS]\n${correctionsBlock}`;
  const augmentedUserMessage = userMessage + userContext;

  // 5. Build messages array
  const systemWithTime = SYSTEM_PROMPT + `\nCurrent time: ${timeStr}`;
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemWithTime },
    ...history,
    { role: "user", content: augmentedUserMessage },
  ];

  // Send metadata about retrieval
  yield {
    type: "metadata",
    data: JSON.stringify({
      memories_found: memories.length,
      retrieve_ms: retrieveMs,
      memory_available: memoryAvailable,
    }),
  };

  // 6. Ollama agentic loop
  let responseText = "";
  let toolCallsMade: Array<{ name: string; args: Record<string, unknown>; result: Record<string, unknown> }> = [];

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const payload: Record<string, unknown> = {
        model: MODEL,
        messages,
        stream: false, // buffer for tool detection
        think: false,
        options: { num_ctx: NUM_CTX },
      };

      // Include tools for all rounds except the last
      if (round < MAX_TOOL_ROUNDS) {
        payload.tools = MEMORY_TOOLS;
      }

      if (round > 0) {
        yield { type: "thinking", data: `Processing tool calls (round ${round})...` };
      }

      const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      });

      if (!resp.ok) {
        throw new Error(`Ollama error: ${resp.status} ${await resp.text()}`);
      }

      const data = await resp.json();
      const msg = data.message || {};
      const content = (msg.content as string) || "";

      // Parse tool calls
      const tools = parseToolCalls(msg);

      if (tools.length > 0 && round < MAX_TOOL_ROUNDS) {
        // Add assistant message with tool calls to context
        const assistantMsg: Record<string, unknown> = { role: "assistant", content };
        if (msg.tool_calls) assistantMsg.tool_calls = msg.tool_calls;
        messages.push(assistantMsg);

        // Execute each tool call
        for (const tc of tools) {
          const name = tc.function.name;
          const args = tc.function.arguments;

          yield { type: "tool_call", data: JSON.stringify({ name, args }) };

          const result = await memoryToolCall(name, args as Record<string, unknown>);
          toolCallsMade.push({ name, args: args as Record<string, unknown>, result });

          messages.push({ role: "tool", content: JSON.stringify(result) });

          // Track corrections for session
          if (name === "memory_store" && (args as Record<string, unknown>).type === "correction") {
            const corrections = sessionCorrections.get(conversationId) || [];
            corrections.push((args as Record<string, unknown>).content as string);
            sessionCorrections.set(conversationId, corrections);
          }
        }
        continue; // Re-call Ollama with tool results
      }

      // Plain text response — done
      responseText = content;
      break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[noah] Ollama error:", message);
    yield { type: "error", data: message };
    return;
  }

  // 7. Strip thinking blocks
  responseText = stripThinking(responseText);
  if (!responseText) {
    responseText = "I'm not sure how to respond to that.";
  }

  // 8. Stream the final response token by token (simulate streaming from buffered)
  // For now, send as one chunk. Real streaming can be added later.
  yield { type: "token", data: responseText };

  // 9. Done event with metadata
  yield {
    type: "done",
    data: JSON.stringify({
      tool_calls: toolCallsMade,
      total_ms: Date.now() - startTime,
    }),
  };
}
