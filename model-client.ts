import { config } from "./config";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id?: string;
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelResponse {
  content: string;
  tool_calls: ToolCall[];
  thinking: string;
}

export interface ModelClient {
  chat(
    messages: Message[],
    opts?: { tools?: ToolDef[]; stream?: false },
  ): Promise<ModelResponse>;
  readonly name: string;
  readonly provider: "local" | "cloud";
}

class OllamaClient implements ModelClient {
  readonly provider = "local" as const;

  get name(): string {
    return config.ollama.model;
  }

  async chat(
    messages: Message[],
    opts?: { tools?: ToolDef[] },
  ): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: config.ollama.model,
      messages: messages.map((m) => {
        const msg: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        return msg;
      }),
      stream: false,
      options: { num_ctx: config.ollama.numCtx },
    };

    if (opts?.tools?.length) {
      body.tools = opts.tools;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.ollama.timeoutMs,
    );

    try {
      const res = await fetch(`${config.ollama.url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama ${res.status}: ${text}`);
      }

      const data = (await res.json()) as {
        message?: {
          content?: string;
          tool_calls?: Array<{
            function: { name: string; arguments: Record<string, unknown> };
          }>;
        };
      };

      const msg = data.message || {};
      return {
        content: msg.content || "",
        tool_calls: msg.tool_calls || [],
        thinking: "",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

class CloudClient implements ModelClient {
  readonly provider = "cloud" as const;

  get name(): string {
    return config.cloud.model;
  }

  async chat(
    messages: Message[],
    opts?: { tools?: ToolDef[] },
  ): Promise<ModelResponse> {
    if (!config.cloud.key) {
      throw new Error(
        "FIREWORKS_API_KEY not set — set the environment variable to use cloud mode",
      );
    }

    const body: Record<string, unknown> = {
      model: config.cloud.model,
      messages: messages.map((m) => {
        const msg: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        if (m.tool_calls) {
          msg.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id || `call_${Date.now()}`,
            type: "function",
            function: {
              name: tc.function.name,
              arguments:
                typeof tc.function.arguments === "string"
                  ? tc.function.arguments
                  : JSON.stringify(tc.function.arguments),
            },
          }));
        }
        if (m.tool_call_id) {
          msg.tool_call_id = m.tool_call_id;
        }
        return msg;
      }),
      stream: false,
    };

    // Bound the response and control hidden reasoning (see config.cloud). These
    // are the levers that keep the reasoning-model cloud path inside the timeout.
    if (config.cloud.maxTokens > 0) {
      body.max_tokens = config.cloud.maxTokens;
    }
    if (config.cloud.reasoningEffort) {
      body.reasoning_effort = config.cloud.reasoningEffort;
    }

    if (opts?.tools?.length) {
      body.tools = opts.tools;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.cloud.timeoutMs,
    );

    try {
      const res = await fetch(`${config.cloud.url}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.cloud.key}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Cloud ${res.status}: ${text}`);
      }

      const data = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
            tool_calls?: Array<{
              id: string;
              function: { name: string; arguments: string };
            }>;
          };
        }>;
      };

      const choice = data.choices?.[0]?.message || {};
      const toolCalls: ToolCall[] = (choice.tool_calls || []).map((tc) => ({
        id: tc.id,
        function: {
          name: tc.function.name,
          arguments: (() => {
            try {
              return JSON.parse(tc.function.arguments);
            } catch {
              return tc.function.arguments;
            }
          })(),
        },
      }));

      return {
        content: choice.content || "",
        tool_calls: toolCalls,
        thinking: "",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createModelClient(): ModelClient {
  const local = new OllamaClient();
  const cloud = new CloudClient();

  return {
    get name() {
      return config.provider === "cloud" ? cloud.name : local.name;
    },
    get provider(): "local" | "cloud" {
      return config.provider;
    },
    chat(
      messages: Message[],
      opts?: { tools?: ToolDef[]; stream?: false },
    ): Promise<ModelResponse> {
      return config.provider === "cloud"
        ? cloud.chat(messages, opts)
        : local.chat(messages, opts);
    },
  };
}
