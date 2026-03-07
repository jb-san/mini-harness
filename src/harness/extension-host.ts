import type { Tool } from "../agent/tool.ts";
import type { ToolRegistry } from "../agent/tool-registry.ts";
import type { MessageBus } from "../mq/bus.ts";
import type { LLMProvider } from "../ai/provider.ts";
import type { Extension, ExtensionAPI } from "./types.ts";
import type { ActorRuntime } from "../runtime/actor-runtime.ts";

export class ExtensionHost {
  private extensions: Extension[] = [];
  private cleanups: (() => void | Promise<void>)[] = [];

  constructor(
    private registry: ToolRegistry,
    private bus: MessageBus,
    private runtime: ActorRuntime,
    private provider: LLMProvider,
    private agentId: string,
    private cwd: string,
    private subAgent: boolean,
  ) {}

  async activate(extensions: Extension[]): Promise<void> {
    for (const ext of extensions) {
      const api = this.createAPI(ext);
      await ext.activate(api);
      this.extensions.push(ext);
      if (ext.deactivate) {
        this.cleanups.push(() => ext.deactivate!());
      }
    }
  }

  async deactivateAll(): Promise<void> {
    for (const cleanup of this.cleanups) {
      await cleanup();
    }
    this.cleanups = [];
    this.extensions = [];
  }

  private createAPI(_ext: Extension): ExtensionAPI {
    return {
      registerTool: (tool: Tool) => {
        this.registry.register(tool);
      },
      unregisterTool: (name: string) => {
        this.registry.unregister(name);
      },
      bus: this.bus,
      getProvider: () => this.provider,
      getRegistry: () => this.registry,
      getRuntime: () => this.runtime,
      getAgentId: () => this.agentId,
      getCwd: () => this.cwd,
      isSubAgent: () => this.subAgent,
    };
  }
}
