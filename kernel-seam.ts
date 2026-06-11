import type { RecalledMemory } from "./memory-client";

export interface KernelInput {
  userMessage: string;
  memories: RecalledMemory[];
  conversationHistory: Array<{ role: string; content: string }>;
}

export interface KernelOutput {
  processedMessage: string;
  processedMemories: RecalledMemory[];
  metadata: Record<string, unknown>;
}

export interface KernelSeam {
  process(input: KernelInput): Promise<KernelOutput>;
  health(): Promise<{ ok: boolean; version: string }>;
}

export class PassthroughKernel implements KernelSeam {
  async process(input: KernelInput): Promise<KernelOutput> {
    return {
      processedMessage: input.userMessage,
      processedMemories: input.memories,
      metadata: { kernel: "passthrough", version: "none" },
    };
  }

  async health(): Promise<{ ok: boolean; version: string }> {
    return { ok: true, version: "none" };
  }
}

export function createKernel(): KernelSeam {
  return new PassthroughKernel();
}
