import { OpenAICompatibleProvider } from "../ai/providers/openai-compatible.ts";
import { ToolRegistry } from "../agent/tool-registry.ts";
import { ExtensionHost } from "./extension-host.ts";
import type { HarnessConfig } from "./types.ts";
import { ActorRuntime } from "../runtime/actor-runtime.ts";

// Core tools
import { readFile } from "../agent/tools/read-file.ts";
import { writeFile } from "../agent/tools/write-file.ts";
import { listDir } from "../agent/tools/list-dir.ts";
import { runShell } from "../agent/tools/run-shell.ts";

export async function createHarness(config: HarnessConfig) {
  const model = config.model ?? "qwen/qwen3.5-35b-a3b";
  const baseUrl = config.baseUrl ?? "http://localhost:1234/v1";
  const maxTokens = config.maxTokens ?? 202752;
  const agentId = config.agentId ?? "main";
  const isSubAgent = config.isSubAgent ?? false;
  const bus = config.bus;
  const runtime = config.runtime ?? new ActorRuntime(bus);

  const provider = new OpenAICompatibleProvider({ baseUrl, model, maxTokens });
  const registry = new ToolRegistry();

  // Register core tools
  registry.register(readFile);
  registry.register(writeFile);
  registry.register(listDir);
  registry.register(runShell);

  // Activate extensions
  const extensionHost = new ExtensionHost(
    registry,
    bus,
    runtime,
    provider,
    agentId,
    process.cwd(),
    isSubAgent,
  );
  if (config.extensions) {
    await extensionHost.activate(config.extensions);
  }

  return {
    provider,
    registry,
    bus,
    runtime,
    extensionHost,

    async destroy() {
      await extensionHost.deactivateAll();
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
