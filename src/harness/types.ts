import type { Tool } from "../agent/tool.ts";
import type { MessageBus } from "../mq/bus.ts";
import type { LLMProvider } from "../ai/provider.ts";
import type { ToolRegistry } from "../agent/tool-registry.ts";
import type { ActorRuntime } from "../runtime/actor-runtime.ts";

export interface ExtensionAPI {
  registerTool(tool: Tool): void;
  unregisterTool(name: string): void;
  bus: MessageBus;
  getProvider(): LLMProvider;
  getRegistry(): ToolRegistry;
  getRuntime(): ActorRuntime;
  getAgentId(): string;
  getCwd(): string;
  isSubAgent(): boolean;
}

export interface Extension {
  name: string;
  activate(api: ExtensionAPI): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export interface HarnessConfig {
  bus: MessageBus;
  runtime?: ActorRuntime;
  extensions?: Extension[];
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  systemPrompt?: string;
  agentId?: string;
  isSubAgent?: boolean;
}
