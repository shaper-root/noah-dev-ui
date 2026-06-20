import type { ToolDef, ToolCall } from "./model-client";
import { wrapWebResearchAsData, wrapVaultAsData } from "./data-boundary";
import { memoryClient } from "./memory-client";
import { webResearch } from "./web-research";
import { config } from "./config";
import { log } from "./logger";
import {
  searchVault,
  readVaultFile,
  vaultStats,
  vaultAvailable,
  vaultProvenance,
} from "./vault";
import { loadVaultIndex, refreshVaultIndex } from "./vault-index";

// Schema-valid enum values. Kept here as the SINGLE source of truth for the
// runtime coercion in dispatchTool (the tool defs above embed the same lists
// so the model SEES them; this is the defense-in-depth check for when the
// model emits an unlisted value anyway — e.g. text-parsed tool calls from a
// non-tool-aware model, or hallucinated values).
const VALID_TYPES = new Set([
  "fact", "value", "preference", "constraint", "convention", "principle",
  "goal", "relationship", "boundary", "event", "skill", "context",
]);
const VALID_CATEGORIES = new Set([
  "permanent", "durable", "stable", "evolving", "volatile",
]);

/** Map common model-picked-but-invalid type values onto their closest
 *  schema-valid equivalent. Anything not in this map AND not in VALID_TYPES
 *  falls back to "fact" (the safe default). */
const TYPE_COERCIONS: Record<string, string> = {
  // Pre-fix tool-router had these — the model may still emit them from older
  // prompt influence.
  feedback: "constraint", // a correction is a constraint on future behavior
  instruction: "constraint",
  belief: "principle",
  habit: "convention",
  insight: "fact",
  experience: "event",
};

/**
 * Pure coercion of memory_remember's enum-constrained args to schema-valid
 * values. Exported so the coercion is unit-testable WITHOUT mocking the
 * memory-client singleton (which would compete with the process-global
 * mock.module from noah.test.ts and vault-bridge.test.ts).
 *
 *  - `type`: schema-valid → unchanged. Mapped in TYPE_COERCIONS → mapped
 *    value. Anything else → "fact". `undefined`/non-string → `undefined`
 *    (the memory-api side defaults type:"fact").
 *  - `category`: schema-valid → unchanged. Anything else → `undefined`
 *    (NULL in the DB, which is explicitly valid).
 *
 * Logs a warn on any rewrite so pattern-drift surfaces in the structured log.
 */
export function coerceMemoryArgs(args: {
  type?: unknown;
  category?: unknown;
}): { type?: string; category?: string } {
  let type: string | undefined;
  if (typeof args.type === "string") {
    if (VALID_TYPES.has(args.type)) {
      type = args.type;
    } else {
      const mapped = TYPE_COERCIONS[args.type] ?? "fact";
      log("warn", "memory.write.coerce_type", { from: args.type, to: mapped });
      type = mapped;
    }
  }
  let category: string | undefined;
  if (typeof args.category === "string") {
    if (VALID_CATEGORIES.has(args.category)) {
      category = args.category;
    } else {
      log("warn", "memory.write.coerce_category", {
        from: args.category,
        to: "(dropped → NULL)",
      });
      category = undefined;
    }
  }
  return { type, category };
}

const MEMORY_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "memory_remember",
      description:
        "Store a new memory. The system evaluates worthiness automatically — " +
        "not everything will be stored.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The memory content to store",
          },
          type: {
            type: "string",
            // MUST match the memory-api schema CHECK constraint
            // (memory-api/src/storage/schema.ts). Any value outside this list
            // is coerced to "fact" in dispatchTool before the MCP call. This
            // enum had drifted (experience/belief/habit/instruction/feedback/
            // insight were never schema-valid) and triggered late-write
            // CHECK-constraint failures the model couldn't recover from.
            enum: [
              "fact",
              "value",
              "preference",
              "constraint",
              "convention",
              "principle",
              "goal",
              "relationship",
              "boundary",
              "event",
              "skill",
              "context",
            ],
            default: "fact",
            description: "Kind of memory",
          },
          category: {
            type: "string",
            // MUST match the schema (permanent/durable/stable/evolving/
            // volatile or NULL). Any other value is dropped (NULL) in
            // dispatchTool.
            enum: ["permanent", "durable", "stable", "evolving", "volatile"],
            description:
              "Volatility tier (controls decay rate). Omit when unknown — NULL is valid.",
          },
          scope: {
            type: "string",
            description: "Scope or domain this memory belongs to",
          },
          entities: {
            type: "array",
            items: { type: "string" },
            description: "Named entities referenced in this memory",
          },
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "Keywords for retrieval",
          },
          supersedes: {
            type: "string",
            description: "UUID of the memory this supersedes",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_recall",
      description:
        "Search memories by semantic similarity, keywords, and entities. " +
        "Returns ranked results with provenance.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
          scope: {
            type: "string",
            description: "Filter by scope",
          },
          type: {
            type: "string",
            // Must match the schema for the filter to ever match a stored row.
            enum: [
              "fact",
              "value",
              "preference",
              "constraint",
              "convention",
              "principle",
              "goal",
              "relationship",
              "boundary",
              "event",
              "skill",
              "context",
            ],
            description: "Filter by memory type",
          },
          entities: {
            type: "array",
            items: { type: "string" },
            description: "Filter by entities",
          },
          topK: {
            type: "number",
            default: 10,
            maximum: 100,
            description: "Number of results to return",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_forget",
      description: "Mark a memory as superseded (ADD-only — does not delete).",
      parameters: {
        type: "object",
        properties: {
          memory_id: {
            type: "string",
            description: "UUID of the memory to forget",
          },
        },
        required: ["memory_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_inspect",
      description: "Get full details of a specific memory by ID.",
      parameters: {
        type: "object",
        properties: {
          memory_id: {
            type: "string",
            description: "UUID of the memory to inspect",
          },
        },
        required: ["memory_id"],
      },
    },
  },
];

const WEB_RESEARCH_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "web_research",
    description:
      "Search the web for factual information. Use when memory and training " +
      "data are insufficient. Read-only — results carry 60% trust.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
      },
      required: ["query"],
    },
  },
};

const VAULT_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "vault_search",
      description:
        "Search Root's Obsidian vault (his curated markdown notes) by keyword. " +
        "READ-ONLY. Ranks by title and section-header (topic) matches, not just " +
        "filename, and returns each hit's title + topic hints so you can pick what " +
        "to read. Omit the query to get a vault overview instead (directory " +
        "breakdown + the most recently modified notes) — use that to answer 'what's " +
        "in my vault' or 'what topics do I have notes on'. Set refresh=true to " +
        "rebuild the index when Root says it's stale. Each result carries its own " +
        "per-file provenance + trust tag — read it; trust is not a blanket (most " +
        "files are unverified/~0.5, only confirmed Root-authored locations are ~0.9).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Keywords to search for. Omit or leave empty to get the vault overview.",
          },
          refresh: {
            type: "boolean",
            description:
              "Rebuild the vault index before answering. Use when Root asks to refresh/re-scan the vault.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_read",
      description:
        "Read the full content of one file from Root's Obsidian vault, by its " +
        "vault-relative path (as returned by vault_search). READ-ONLY.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Vault-relative file path, e.g. '05-projects/noah.md'",
          },
        },
        required: ["path"],
      },
    },
  },
];

export function getAllTools(): ToolDef[] {
  const tools = [...MEMORY_TOOLS, WEB_RESEARCH_TOOL];
  // Only advertise vault tools when the vault is actually reachable, so the model
  // isn't offered a capability that will always error.
  if (config.vault.enabled && vaultAvailable()) {
    tools.push(...VAULT_TOOLS);
  }
  return tools;
}

/**
 * Memory tools only. Used by noah.ts as the "always available" carve-out so a
 * memory_remember call is never silently dropped by the context/round guard
 * (Phase 2B): the worst-case behavior is one extra round whose work the forced-
 * final completion absorbs into plain text, NOT a lost write.
 */
export function getMemoryTools(): ToolDef[] {
  return [...MEMORY_TOOLS];
}

export async function dispatchTool(
  call: ToolCall,
): Promise<string> {
  const name = call.function.name;
  // Defensive: callers (noah.ts) normally pass an already-parsed object. If a
  // raw string slips through, parse it safely — never throw out of dispatch.
  const rawArgs = call.function.arguments;
  let args: Record<string, any>;
  if (typeof rawArgs === "string") {
    try {
      args = JSON.parse(rawArgs || "{}");
    } catch {
      args = {};
    }
  } else {
    args = (rawArgs as Record<string, any>) ?? {};
  }

  // Defense-in-depth: dispatchTool must NEVER throw out of here. Any tool
  // failure — network/fetch error, MCP reject, a future tool impl, an
  // unexpected throw — is converted to a structured error STRING so the turn
  // degrades gracefully and the SSE stream never dies. (The arg-parse above is
  // already guarded; this wraps every tool implementation in the switch.)
  try {
  switch (name) {
    case "memory_remember": {
      // Auto-fill provenance: every stored memory carries the model that wrote
      // it. Uses the existing `source_ref` column (no schema change). Format is
      // "model:<provider>:<model_id>" so future trust gates can key on it.
      const modelId =
        config.provider === "local" ? config.ollama.model : config.cloud.model;
      // Default provenance is the writing model. noah.ts may override `source_ref`
      // (host-controlled — e.g. attachment:{file}:{date} on attachment turns); the
      // MCP tool schema does NOT advertise this arg, so a bare model can't set it.
      const sourceRef =
        typeof args.source_ref === "string" && args.source_ref.trim()
          ? args.source_ref.trim()
          : `model:${config.provider}:${modelId}`;

      // `explicit` is injected into the tool args by noah.ts when the user's
      // message expresses an unambiguous "remember this" intent. The MCP server
      // then bypasses the worthiness gate for the write.
      const explicit = args.explicit === true;

      // Defense-in-depth: coerce type/category to schema-valid values so a
      // model-picked out-of-enum value can't blow up the write with a CHECK
      // constraint failure. See coerceMemoryArgs above.
      const { type: safeType, category: safeCategory } = coerceMemoryArgs(args);

      const result = await memoryClient.remember(args.content, {
        type: safeType,
        category: safeCategory,
        scope: args.scope,
        entities: args.entities,
        keywords: args.keywords,
        supersedes: args.supersedes,
        sourceRef,
        explicit,
      });
      // ALWAYS a structured object now — never the legacy "Memory unavailable"
      // string. On failure, attach an explicit advisory so the model cannot
      // silently claim "stored" when the write was rejected or unavailable.
      if (!result.stored) {
        return JSON.stringify({
          ...result,
          _agent_advisory:
            "Memory write FAILED. Do NOT tell the user it was stored. " +
            "Acknowledge the failure honestly: 'I tried to store that, but the " +
            "write failed (" +
            (result.kind ?? "unknown") +
            "). Tell me again next session if it matters.' Then proceed.",
        });
      }
      return JSON.stringify(result);
    }

    case "memory_recall": {
      const result = await memoryClient.recall(args.query, {
        topK: args.topK,
        type: args.type,
        scope: args.scope,
        entities: args.entities,
      });
      return JSON.stringify(result);
    }

    case "memory_forget": {
      const result = await memoryClient.forget(args.memory_id);
      return JSON.stringify(result ?? { error: "Memory unavailable" });
    }

    case "memory_inspect": {
      const result = await memoryClient.inspect(args.memory_id);
      return JSON.stringify(result ?? { error: "Memory unavailable" });
    }

    case "web_research": {
      const result = await webResearch(args.query);
      return wrapWebResearchAsData(result.query, result.results);
    }

    case "vault_search": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const refresh = args.refresh === true;
      // Explicit refresh: rebuild the index before answering ("re-scan my vault").
      if (refresh) refreshVaultIndex();
      // No query → overview mode: the index digest (directory breakdown + most
      // recent notes) answers "what's in my vault" / "what topics do I have".
      if (!query) {
        const idx = loadVaultIndex();
        const stats = vaultStats();
        return JSON.stringify({
          source: "obsidian_vault",
          total_files: stats.fileCount,
          total_bytes: stats.totalBytes,
          overview: idx.active ? idx.compactSummary : undefined,
          refreshed: refresh || undefined,
          // No blanket vault trust: trust is PER FILE, surfaced when you actually
          // vault_read a specific file (provenance.ts), not a vault-wide score.
          note:
            "Vault overview (file listing + counts). Trust is per-file — surfaced " +
            "when you vault_read a specific file, not a blanket vault score. To read " +
            "a file, call vault_read with its path.",
        });
      }
      const hits = searchVault(query);
      if (!hits.length) {
        return JSON.stringify({
          source: "obsidian_vault",
          query,
          results: [],
          note: "No matching vault content found.",
        });
      }
      return wrapVaultAsData(
        hits.map((h) => {
          const prov = vaultProvenance(h.path);
          return {
            path: h.path,
            title: h.title,
            topics: h.topics,
            text: h.snippet,
            provenance: prov.provenance,
            trust: prov.trust,
          };
        }),
      );
    }

    case "vault_read": {
      const path = typeof args.path === "string" ? args.path : "";
      const result = readVaultFile(path);
      if (!result.ok) {
        return JSON.stringify({ source: "obsidian_vault", error: result.error });
      }
      const prov = vaultProvenance(result.path!, result.content!);
      return wrapVaultAsData([
        {
          path: result.path!,
          text: result.content!,
          truncated: result.truncated,
          provenance: prov.provenance,
          trust: prov.trust,
        },
      ]);
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", "tool.dispatch.threw", { name, err: msg });
    return JSON.stringify({ error: `Tool ${name} failed: ${msg}` });
  }
}
