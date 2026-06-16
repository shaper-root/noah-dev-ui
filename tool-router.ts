import type { ToolDef, ToolCall } from "./model-client";
import { wrapWebResearchAsData, wrapVaultAsData } from "./data-boundary";
import { memoryClient } from "./memory-client";
import { webResearch } from "./web-research";
import { config } from "./config";
import {
  searchVault,
  readVaultFile,
  vaultStats,
  vaultAvailable,
} from "./vault";

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
            enum: [
              "fact",
              "preference",
              "skill",
              "goal",
              "relationship",
              "experience",
              "belief",
              "habit",
              "context",
              "instruction",
              "feedback",
              "insight",
            ],
            default: "fact",
            description: "Kind of memory",
          },
          category: {
            type: "string",
            enum: [
              "identity",
              "stable",
              "evolving",
              "situational",
              "ephemeral",
            ],
            description: "Volatility level",
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
            enum: [
              "fact",
              "preference",
              "skill",
              "goal",
              "relationship",
              "experience",
              "belief",
              "habit",
              "context",
              "instruction",
              "feedback",
              "insight",
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
        "READ-ONLY. Returns matching files with snippets. Omit the query to get the " +
        "total file count and a listing instead — use that to answer 'how many files' " +
        "or 'what's in my vault'. Vault content carries 90% trust (Root's own notes).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Keywords to search for. Omit or leave empty to list/count all files.",
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

  switch (name) {
    case "memory_remember": {
      // Auto-fill provenance: every stored memory carries the model that wrote
      // it. Uses the existing `source_ref` column (no schema change). Format is
      // "model:<provider>:<model_id>" so future trust gates can key on it.
      const modelId =
        config.provider === "local" ? config.ollama.model : config.cloud.model;
      const sourceRef = `model:${config.provider}:${modelId}`;

      // `explicit` is injected into the tool args by noah.ts when the user's
      // message expresses an unambiguous "remember this" intent. The MCP server
      // then bypasses the worthiness gate for the write.
      const explicit = args.explicit === true;

      const result = await memoryClient.remember(args.content, {
        type: args.type,
        category: args.category,
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
      // No query → listing/count mode (answers "how many files in my vault").
      if (!query) {
        const stats = vaultStats();
        return JSON.stringify({
          source: "obsidian_vault",
          trust: config.vault.trust,
          total_files: stats.fileCount,
          total_bytes: stats.totalBytes,
          note: "Vault listing — to read a file, call vault_read with its path.",
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
        hits.map((h) => ({ path: h.path, text: h.snippet })),
      );
    }

    case "vault_read": {
      const path = typeof args.path === "string" ? args.path : "";
      const result = readVaultFile(path);
      if (!result.ok) {
        return JSON.stringify({ source: "obsidian_vault", error: result.error });
      }
      return wrapVaultAsData([
        {
          path: result.path!,
          text: result.content!,
          truncated: result.truncated,
        },
      ]);
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}
