import type { Message, ChatToolDef, StreamCallbacks, StreamResult } from "./types.ts";

export interface LLMProvider {
  id: string;
  chat(
    params: { messages: Message[]; tools?: ChatToolDef[]; model?: string },
    callbacks?: StreamCallbacks,
  ): Promise<StreamResult>;
}

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  getDefault(): LLMProvider {
    const first = this.providers.values().next();
    if (first.done) throw new Error("No providers registered");
    return first.value;
  }
}
