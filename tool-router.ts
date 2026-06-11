import type { ToolDef, ToolCall } from "./model-client";
import { wrapWebResearchAsData } from "./data-boundary";
import { memoryClient } from "./memory-client";
import { webResearch } from "./web-research";

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

export function getAllTools(): ToolDef[] {
  return [...MEMORY_TOOLS, WEB_RESEARCH_TOOL];
}

export async function dispatchTool(
  call: ToolCall,
): Promise<string> {
  const name = call.function.name;
  const args =
    typeof call.function.arguments === "string"
      ? JSON.parse(call.function.arguments)
      : call.function.arguments;

  switch (name) {
    case "memory_remember": {
      const result = await memoryClient.remember(args.content, {
        type: args.type,
        category: args.category,
        scope: args.scope,
        entities: args.entities,
        keywords: args.keywords,
        supersedes: args.supersedes,
      });
      return JSON.stringify(result ?? { error: "Memory unavailable" });
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

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}
