import { test, expect } from "bun:test";
import { MessageBus } from "../../mq/bus.ts";
import { ToolRegistry } from "../../agent/tool-registry.ts";
import { agentsExtension } from "./index.ts";
import type { LLMProvider } from "../../ai/provider.ts";
import type { StreamResult, StreamCallbacks, Message, ChatToolDef } from "../../ai/types.ts";
import { ActorRuntime } from "../../runtime/actor-runtime.ts";

function createMockProvider(response: StreamResult): LLMProvider & { getModel(): string; getMaxTokens(): number } {
  return {
    id: "mock",
    getModel: () => "mock-model",
    getMaxTokens: () => 1000,
    async chat(_params: { messages: Message[]; tools?: ChatToolDef[] }, callbacks?: StreamCallbacks): Promise<StreamResult> {
      if (response.assistantText && callbacks?.onContent) {
        callbacks.onContent(response.assistantText);
      }
      return response;
    },
  };
}

test("agents extension registers 3 tools for main agent", async () => {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const registry = new ToolRegistry();
  const provider = createMockProvider({ toolCalls: [], assistantText: "ok", usage: null });
  const tools: string[] = [];

  await agentsExtension.activate({
    registerTool: (t) => tools.push(t.definition.name),
    unregisterTool: () => {},
    bus,
    getProvider: () => provider,
    getRegistry: () => registry,
    getRuntime: () => runtime,
    getAgentId: () => "main",
    getCwd: () => "/tmp",
    isSubAgent: () => false,
  });

  expect(tools.sort()).toEqual(["check_agents", "get_agent_result", "spawn_agent"]);
});

test("agents extension registers no tools for sub-agents", async () => {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const tools: string[] = [];

  await agentsExtension.activate({
    registerTool: (t) => tools.push(t.definition.name),
    unregisterTool: () => {},
    bus,
    getProvider: () => ({} as any),
    getRegistry: () => ({} as any),
    getRuntime: () => runtime,
    getAgentId: () => "a001",
    getCwd: () => "/tmp",
    isSubAgent: () => true,
  });

  expect(tools).toEqual([]);
});

test("spawn_agent emits agent:spawned and creates in-process agent", async () => {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const registry = new ToolRegistry();
  const provider = createMockProvider({ toolCalls: [], assistantText: "Sub-agent done", usage: null });

  let spawnedPayload: any = null;
  bus.on("agent:spawned", (p) => { spawnedPayload = p; });

  // Collect registered tools so we can call spawn_agent
  const registeredTools = new Map<string, any>();

  await agentsExtension.activate({
    registerTool: (t) => registeredTools.set(t.definition.name, t),
    unregisterTool: () => {},
    bus,
    getProvider: () => provider,
    getRegistry: () => registry,
    getRuntime: () => runtime,
    getAgentId: () => "main",
    getCwd: () => "/tmp",
    isSubAgent: () => false,
  });

  const spawnTool = registeredTools.get("spawn_agent");
  const result = await spawnTool.execute(
    { prompt: "Do something" },
    { cwd: "/tmp", agentId: "main", isSubAgent: false },
  );

  const parsed = JSON.parse(result);
  expect(parsed.status).toBe("spawned");
  expect(parsed.agent_id).toMatch(/^a\d+/);
  expect(spawnedPayload).not.toBeNull();
  expect(spawnedPayload.prompt).toBe("Do something");
});
