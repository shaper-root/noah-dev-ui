import { Hono } from "hono";
import { DB } from "./db";
import { config, validateConfig } from "./config";
import { chat } from "./noah";
import { memoryClient } from "./memory-client";
import { createModelClient } from "./model-client";
import {
  reconcileMemoryExports,
  importMemoriesFromOtherDevices,
  reconcileSessionSummaries,
  reconcileObservations,
  summarizeConversation,
  buildObservationsFromConversation,
  appendObservations,
} from "./vault-bridge";
import {
  extractText,
  classifyFile,
  placeFile,
  moveFile,
  deleteFileFromDisk,
  detectMimeType,
  SUPPORTED_EXTENSIONS,
  UPLOADS_DIR,
} from "./files";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, extname, sep } from "path";
import { dashboardRoutes } from "./routes/dashboard";
import { dreamRoutes } from "./routes/dream";
import { rulesRoutes } from "./routes/rules";
import { analyticsRoutes } from "./routes/analytics";
import { formatSSE, formatSSEComment, type SSEEventName } from "./sse";

const app = new Hono();
const PORT = 3333;

// Serve index.html
const indexHtml = readFileSync(resolve(import.meta.dir, "index.html"), "utf-8");
app.get("/", (c) => c.html(indexHtml));

// --- Serve UI modules ---
app.get("/ui/:file", async (c) => {
  const file = c.req.param("file");
  // Only allow flat .js filenames — no path separators
  if (!/^[\w.-]+\.js$/.test(file)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const filePath = resolve(import.meta.dir, "ui", file);
  const uiDir = resolve(import.meta.dir, "ui") + sep;
  if (!filePath.startsWith(uiDir)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const bunFile = Bun.file(filePath);
  if (!(await bunFile.exists())) {
    return c.json({ error: "Not found" }, 404);
  }
  return new Response(bunFile, {
    headers: { "Content-Type": "application/javascript" },
  });
});

// --- Mount feature routes ---
app.route("/api/dashboard", dashboardRoutes);
app.route("/api/dream", dreamRoutes);
app.route("/api/rules", rulesRoutes);
app.route("/api/analytics", analyticsRoutes);


// --- Conversations ---

app.get("/api/conversations", (c) => {
  const limit = Math.min(Number(c.req.query("limit") || "50"), 200);
  const archived = Number(c.req.query("archived") || "0") ? 1 : 0;
  const conversations = DB.listConversations(limit, archived);
  // Attach feedback counts
  const enriched = conversations.map((conv) => {
    const feedback = DB.getFeedback(conv.id);
    return {
      ...conv,
      feedback_count: feedback.length,
      positive_count: feedback.filter((f) => f.type === "positive").length,
      negative_count: feedback.filter((f) => f.type === "negative").length,
    };
  });
  return c.json(enriched);
});

app.get("/api/conversations/:id", (c) => {
  const id = c.req.param("id");
  const conv = DB.getConversation(id);
  if (!conv) return c.json({ error: "Not found" }, 404);

  const messages = DB.getMessages(id);
  const feedback = DB.getFeedback(id);
  return c.json({ conversation: conv, messages, feedback });
});

app.put("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const conv = DB.getConversation(id);
  if (!conv) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json();
  if (body.title) {
    DB.updateConversationTitle(id, body.title);
  }
  return c.json({ ok: true });
});

app.put("/api/conversations/:id/archive", (c) => {
  const id = c.req.param("id");
  DB.archiveConversation(id, true);
  return c.json({ ok: true });
});

app.put("/api/conversations/:id/unarchive", (c) => {
  const id = c.req.param("id");
  DB.archiveConversation(id, false);
  return c.json({ ok: true });
});

app.delete("/api/conversations/:id", (c) => {
  const id = c.req.param("id");
  DB.deleteConversation(id);
  return c.json({ ok: true });
});

// --- Chat (SSE) ---

app.post("/api/chat", async (c) => {
  const body = await c.req.json();
  const userMessage: string = body.message;
  let conversationId: string | undefined = body.conversation_id;
  const externalHistory: Array<{ role: string; content: string }> | undefined =
    body.history;

  if (!userMessage) {
    return c.json({ error: "message is required" }, 400);
  }

  // Passthrough mode: caller provides history, skip local DB
  const passthrough = Array.isArray(externalHistory);
  let history: Array<{ role: string; content: string }>;
  let userMsgId: string | undefined;

  if (passthrough) {
    history = externalHistory;
    conversationId = conversationId || "external";
  } else {
    if (!conversationId) {
      const conv = DB.createConversation(userMessage);
      conversationId = conv.id;
    }
    const dbMessages = DB.getMessages(conversationId);
    history = dbMessages.map((m) => ({ role: m.role, content: m.content }));
    userMsgId = DB.addMessage(conversationId, "user", userMessage);
  }

  // Stream response via SSE
  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let terminated = false; // a done/error event has been emitted
        let closed = false; // the consumer is gone; stop writing

        // Write a pre-encoded chunk. If the consumer has disconnected,
        // controller.enqueue throws — swallow it and mark the stream closed so
        // the generator runs to completion (chat.done logs, message persists)
        // instead of being abandoned mid-flight.
        const write = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        };
        // Free-text events (token/thinking/error) are JSON-encoded so multi-line
        // model output cannot break SSE framing. metadata/tool_call/done are
        // already JSON object strings.
        const send = (event: SSEEventName, data: string) => write(formatSSE(event, data));

        // SSE keepalive: comment line every 5s feeds the connection during long
        // model responses. MUST stay comfortably below the server idleTimeout
        // (set to 255s on the default export) — a keepalive interval equal to the
        // idle timeout races it and the connection dies mid-stream (the
        // metadata-only truncation bug on slow/cold turns).
        const keepalive = setInterval(() => write(formatSSEComment("keepalive")), 5_000);

        // Send conversation ID first (for new conversations)
        send("conversation_id", conversationId!);

        let fullResponse = "";

        try {
          for await (const event of chat(userMessage, conversationId!, history)) {
            switch (event.type) {
              case "token":
                fullResponse += event.data;
                send("token", JSON.stringify(event.data));
                break;
              case "thinking":
                send("thinking", JSON.stringify(event.data));
                break;
              case "tool_call":
                send("tool_call", event.data);
                break;
              case "metadata":
                send("metadata", event.data);
                break;
              case "error":
                send("error", JSON.stringify(event.data));
                terminated = true;
                break;
              case "done": {
                const doneData = JSON.parse(event.data);
                let assistantMsgId: string | undefined;
                if (!passthrough) {
                  assistantMsgId = DB.addMessage(
                    conversationId!,
                    "assistant",
                    fullResponse,
                    {
                      tool_calls: doneData.tool_calls,
                      total_ms: doneData.total_ms,
                    }
                  );
                }
                send("done", JSON.stringify({
                  ...doneData,
                  ...(userMsgId && { user_message_id: userMsgId }),
                  ...(assistantMsgId && { assistant_message_id: assistantMsgId }),
                  conversation_id: conversationId,
                }));
                terminated = true;
                break;
              }
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send("error", JSON.stringify(message));
          terminated = true;
        } finally {
          clearInterval(keepalive);
          // Clean stream termination: never let the stream just stop. If the
          // generator exited without a done/error event, tell the consumer
          // explicitly so it can finalize rather than hang.
          if (!terminated) {
            send("error", JSON.stringify("Stream ended without completion"));
          }
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }
  );
});

// --- Mode ---

app.get("/api/mode", (c) => {
  return c.json({
    mode: config.provider,
    model:
      config.provider === "local" ? config.ollama.model : config.cloud.model,
    cloud_available: !!config.cloud.key,
  });
});

app.post("/api/mode", async (c) => {
  const body = await c.req.json();
  const mode = body.mode;
  if (mode !== "local" && mode !== "cloud") {
    return c.json({ error: "mode must be 'local' or 'cloud'" }, 400);
  }
  if (mode === "cloud" && !config.cloud.key) {
    return c.json(
      { error: "FIREWORKS_API_KEY not set — cannot switch to cloud mode" },
      400,
    );
  }
  config.provider = mode as "local" | "cloud";
  console.log(`[noah] Mode switched to: ${mode}`);
  return c.json({
    mode: config.provider,
    model:
      config.provider === "local" ? config.ollama.model : config.cloud.model,
  });
});

// --- System Messages (Dream Mode notifications) ---
// Accepts messages only from noah-memory's dream mode.
// No auth (localhost-only dev tool), but validated and capped.

const SYSTEM_MSG_MAX_LENGTH = 2000;
const SYSTEM_MSG_ALLOWED_SOURCES = new Set(["dream_mode", "watchdog"]);

app.post("/api/system-message", async (c) => {
  const body = await c.req.json();
  const content: string = body.content;
  const source: string = body.source || "dream_mode";

  if (!content) {
    return c.json({ error: "content is required" }, 400);
  }
  if (!SYSTEM_MSG_ALLOWED_SOURCES.has(source)) {
    return c.json({ error: `invalid source: ${source}` }, 400);
  }
  if (content.length > SYSTEM_MSG_MAX_LENGTH) {
    return c.json({ error: `content exceeds ${SYSTEM_MSG_MAX_LENGTH} chars` }, 400);
  }

  // Inject into the most recent conversation, or create one
  let conversations = DB.listConversations(1);
  let conversationId: string;

  if (conversations.length > 0) {
    conversationId = conversations[0].id;
  } else {
    const conv = DB.createConversation("Dream Mode");
    conversationId = conv.id;
  }

  const msgId = DB.addMessage(conversationId, "assistant", content, {
    source,
    type: "system_notification",
  });

  return c.json({ ok: true, conversation_id: conversationId, message_id: msgId });
});

// --- Feedback ---

app.post("/api/feedback", async (c) => {
  const body = await c.req.json();
  const { message_id, type, category, correction_text } = body;

  if (!message_id || !type) {
    return c.json({ error: "message_id and type are required" }, 400);
  }

  const id = DB.addFeedback(message_id, type, category || null, correction_text || null);
  return c.json({ id, ok: true });
});

// --- Search ---

app.get("/api/search", (c) => {
  const query = c.req.query("q");
  if (!query) return c.json({ error: "q is required" }, 400);

  const results = DB.search(query);
  // Enrich with conversation titles
  const enriched = results.map((r) => {
    const conv = DB.getConversation(r.conversation_id);
    return {
      ...r,
      conversation_title: conv?.title || "Unknown",
    };
  });
  return c.json(enriched);
});

// --- Files ---

app.post("/api/files/upload", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];

  if (!file || typeof file === "string") {
    return c.json({ error: "file is required" }, 400);
  }

  const originalName = file.name || "unnamed";
  const ext = extname(originalName).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return c.json({
      error: `Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
    }, 400);
  }

  // Save to temp location first, then extract text + classify
  const tempPath = resolve(UPLOADS_DIR, `.tmp-${crypto.randomUUID()}${ext}`);
  const arrayBuf = await file.arrayBuffer();
  writeFileSync(tempPath, Buffer.from(arrayBuf));

  const mimeType = detectMimeType(originalName);
  const contentText = await extractText(tempPath, mimeType);

  // Classify via Ollama
  const classification = await classifyFile(
    originalName,
    contentText || originalName
  );

  // Place file in organized directory
  const placement = placeFile(classification.category, classification.subcategory, originalName);

  // Move from temp to final location
  const { renameSync } = await import("fs");
  renameSync(tempPath, placement.absolutePath);

  // Store in DB
  const fileRecord = DB.addFile(
    originalName,
    placement.filename,
    classification.category,
    classification.subcategory,
    placement.relativePath,
    mimeType,
    arrayBuf.byteLength,
    contentText
  );

  // Store tags
  if (classification.tags.length > 0) {
    DB.addFileTags(fileRecord.id, classification.tags, true);
  }

  const tags = DB.getFileTags(fileRecord.id);

  return c.json({
    ...fileRecord,
    tags,
    classification,
  });
});

app.get("/api/files", (c) => {
  const category = c.req.query("category");
  const subcategory = c.req.query("subcategory");
  const files = DB.listFiles(category || undefined, subcategory || undefined);

  // Enrich with tags
  const enriched = files.map((f) => ({
    ...f,
    tags: DB.getFileTags(f.id),
  }));
  return c.json(enriched);
});

app.get("/api/files/tree", (c) => {
  const nodes = DB.getCategoryTree();

  // Group into tree structure
  const tree: Record<string, { subcategories: Array<{ name: string; count: number }>; count: number }> = {};

  for (const node of nodes) {
    if (!tree[node.category]) {
      tree[node.category] = { subcategories: [], count: 0 };
    }
    if (node.subcategory) {
      tree[node.category].subcategories.push({ name: node.subcategory, count: node.count });
    } else {
      tree[node.category].count += node.count;
    }
  }

  // Convert to array
  const result = Object.entries(tree).map(([category, data]) => ({
    category,
    subcategories: data.subcategories,
    count: data.count + data.subcategories.reduce((sum, s) => sum + s.count, 0),
  }));

  return c.json(result);
});

app.get("/api/files/search", (c) => {
  const query = c.req.query("q");
  if (!query) return c.json({ error: "q is required" }, 400);

  const results = DB.searchFiles(query);
  const enriched = results.map((r) => {
    const file = DB.getFile(r.file_id);
    return { ...r, file };
  });
  return c.json(enriched);
});

app.get("/api/files/:id", (c) => {
  const id = c.req.param("id");
  const file = DB.getFile(id);
  if (!file) return c.json({ error: "Not found" }, 404);

  const tags = DB.getFileTags(id);
  return c.json({ ...file, tags });
});

app.get("/api/files/:id/raw", (c) => {
  const id = c.req.param("id");
  const file = DB.getFile(id);
  if (!file) return c.json({ error: "Not found" }, 404);

  const absolutePath = resolve(UPLOADS_DIR, file.path);
  // Security: resolve + startsWith guard prevents path traversal
  if (!absolutePath.startsWith(resolve(UPLOADS_DIR))) {
    return c.json({ error: "Forbidden" }, 403);
  }

  return new Response(Bun.file(absolutePath), {
    headers: { "Content-Type": file.mime_type },
  });
});

app.put("/api/files/:id", async (c) => {
  const id = c.req.param("id");
  const file = DB.getFile(id);
  if (!file) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json();

  // Handle tag updates
  if (body.add_tags) {
    DB.addFileTags(id, body.add_tags, false);
  }
  if (body.remove_tag) {
    DB.removeFileTag(id, body.remove_tag);
  }

  // Handle recategorization
  if ((body.category && body.category !== file.category) || (body.subcategory !== undefined && body.subcategory !== file.subcategory)) {
    const newCategory = body.category || file.category;
    const newSubcategory = body.subcategory !== undefined ? body.subcategory : file.subcategory;
    const currentAbsPath = resolve(UPLOADS_DIR, file.path);
    const placement = moveFile(currentAbsPath, newCategory, newSubcategory, file.original_name);
    DB.updateFileCategory(id, newCategory, newSubcategory, placement.relativePath);
  }

  const updated = DB.getFile(id);
  const tags = DB.getFileTags(id);
  return c.json({ ...updated, tags });
});

app.delete("/api/files/:id", (c) => {
  const id = c.req.param("id");
  const file = DB.getFile(id);
  if (!file) return c.json({ error: "Not found" }, 404);

  const absolutePath = resolve(UPLOADS_DIR, file.path);
  deleteFileFromDisk(absolutePath);
  DB.deleteFile(id);

  return c.json({ ok: true });
});

// Serve uploaded files
app.get("/uploads/*", (c) => {
  const decoded = decodeURIComponent(c.req.path.replace("/uploads/", ""));
  const filePath = resolve(UPLOADS_DIR, decoded);
  if (!filePath.startsWith(resolve(UPLOADS_DIR))) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return new Response(Bun.file(filePath));
});

// --- Start ---

console.log(`
  Noah Dev UI
  http://127.0.0.1:${PORT}

  Ollama:      http://127.0.0.1:11434
  noah-memory: http://127.0.0.1:6789
`);

// --- Startup readiness gate ---
// Validate required config (fail fast on missing env), then warm the MCP memory
// child so the FIRST user turn doesn't pay node+tsx cold-start cost (the #1
// first-message race). warmup() is bounded and never throws — if memory is down
// the server still boots and recall degrades gracefully.
validateConfig();
// Await the MCP memory handshake — it's fast (~1-2s) and ensures memory is ready
// for the first turn (the #1 race). Do NOT await the chat-model warm below: it can
// take ~30s and would delay port binding past the launcher's health-check window
// (Bun binds the port only after this module finishes evaluating). Lazy first-token
// model load is acceptable, and slow turns now survive (idleTimeout=255).
await memoryClient.warmup();

// --- Vault-bridge startup reconciliation (Phase 5B) ---
// Run BEFORE serving so the first request lands with a coherent cross-device
// view. Three passes, all bounded so a slow vault can never block boot for
// more than a few seconds:
//
//   1. Export reconciliation: any memory.db row created after the manifest's
//      high-water mark gets exported. Fast (one SELECT + N writes).
//   2. Import: read other-device export files and import new memories via
//      memory_remember. Bounded by the number of unprocessed files.
//   3. Summary + observation reconciliation: deferred to a background task
//      (after we start serving) because summary generation can take 2-5s per
//      conversation and we don't want to delay port binding.

try {
  const exportResult = reconcileMemoryExports();
  console.log(
    `[vault-bridge] Export reconcile: ${exportResult.exported} exported, ${exportResult.skipped} skipped`,
  );
} catch (err) {
  console.warn(
    "[vault-bridge] Export reconcile failed:",
    err instanceof Error ? err.message : err,
  );
}

try {
  const importResult = await importMemoriesFromOtherDevices();
  console.log(
    `[vault-bridge] Import: ${importResult.memoriesStored} stored, ${importResult.memoriesSkippedDuplicate} duplicates, ${importResult.memoriesFailed} failed, ${importResult.filesScanned} files scanned`,
  );
} catch (err) {
  console.warn(
    "[vault-bridge] Import failed:",
    err instanceof Error ? err.message : err,
  );
}

// Summaries + observations: fire-and-forget AFTER port binding so a slow
// summarize doesn't block the launcher's health-check. Each summary involves
// a model call; we cap at 5 per pass.
(async () => {
  try {
    const summaryClient = createModelClient();
    const sumR = await reconcileSessionSummaries(summaryClient, 5);
    console.log(
      `[vault-bridge] Summary reconcile: ${sumR.summarized} written, ${sumR.skipped} skipped`,
    );
    const obsR = reconcileObservations(5);
    console.log(`[vault-bridge] Observations reconcile: ${obsR.written} written`);
  } catch (err) {
    console.warn(
      "[vault-bridge] Background reconcile failed:",
      err instanceof Error ? err.message : err,
    );
  }
})();

// SIGTERM hook (Phase 5A best-effort): if the user (or a launcher) sends
// SIGTERM, try to write a summary + observation for the most recently
// updated conversation before exiting. Bounded by 10s so we don't hang on
// shutdown. If this fails or times out, startup reconciliation on the next
// boot catches it.
const gracefulShutdown = async (signal: string) => {
  console.log(`[noah] ${signal} received — flushing recent session before exit`);
  try {
    const summaryClient = createModelClient();
    const recent = DB.listConversations(1, 0);
    if (recent.length > 0) {
      const convId = recent[0].id;
      const summaryP = summarizeConversation(convId, summaryClient);
      const obsBuilt = buildObservationsFromConversation(convId);
      if (obsBuilt) appendObservations(obsBuilt);
      // 10s cap on the summary write so shutdown doesn't hang.
      await Promise.race([
        summaryP,
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }
  } catch (err) {
    console.warn("[noah] graceful-shutdown flush failed:", err instanceof Error ? err.message : err);
  }
  process.exit(0);
};
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Fire-and-forget local chat-model warm (pages qwen3.5:4b into VRAM in the
// background so the first user turn is fast). Cloud has no cold-load — skipped.
if (config.provider === "local") {
  void fetch(`${config.ollama.url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.ollama.model,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      options: { num_ctx: config.ollama.numCtx },
    }),
    signal: AbortSignal.timeout(30_000),
  })
    .then(() => console.log("[noah] Chat model warm"))
    .catch((err) => console.warn("[noah] Chat model warmup skipped:", err instanceof Error ? err.message : err));
}

console.log("[noah] Startup gate complete (memory ready); serving on :" + PORT);

export default {
  port: PORT,
  hostname: "127.0.0.1",
  development: false,
  // SSE turns can be silent for longer than Bun's 10s default idle timeout
  // (cold model load, long answers, multi-tool rounds). Raise to the max so the
  // connection is never killed mid-generation; keepalives (5s) feed it regardless.
  idleTimeout: 255,
  async fetch(req: Request) {
    const url = new URL(req.url);
    console.log(`[server] ${req.method} ${url.pathname}`);
    try {
      const resp = await app.fetch(req);
      console.log(`[server] ${url.pathname} -> ${resp.status}`);
      return resp;
    } catch (err) {
      console.error("[server] Error:", err);
      return new Response(`Error: ${err instanceof Error ? err.message : err}`, { status: 500 });
    }
  },
  error(err: Error) {
    console.error("[server] Bun error:", err);
    return new Response(`Bun error: ${err.message}`, { status: 500 });
  },
};
