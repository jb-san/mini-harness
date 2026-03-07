import { test, expect } from "bun:test";
import { MessageBus } from "../../mq/bus.ts";
import { ToolRegistry } from "../../agent/tool-registry.ts";
import { createToolExecutor } from "../../agent/tool-executor.ts";
import { Agent } from "../../agent/agent.ts";
import { agentsExtension } from "./index.ts";
import { mqExtension } from "../mq/index.ts";
import type { LLMProvider } from "../../ai/provider.ts";
import type {
  StreamResult,
  StreamCallbacks,
  Message,
  ChatToolDef,
} from "../../ai/types.ts";
import type { Tool } from "../../agent/tool.ts";
import { ActorRuntime } from "../../runtime/actor-runtime.ts";

// --- Helpers ---

function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error("waitFor timed out"));
      setTimeout(check, 5);
    };
    check();
  });
}

/** Extract agent ID from system prompt in message history. */
function detectAgent(messages: Message[]): string {
  const sys = messages.find((m) => m.role === "system");
  if (!sys || typeof sys.content !== "string") return "main";
  const m = sys.content.match(/sub-agent (a\d+)/);
  return m ? m[1] : "main";
}

type ProviderFn = (
  agentId: string,
  callIndex: number,
  messages: Message[],
) => StreamResult;

/** Mock provider that routes calls by agent ID (detected from system prompt). */
function mockProvider(
  fn: ProviderFn,
): LLMProvider & { getModel(): string; getMaxTokens(): number } {
  const counts = new Map<string, number>();
  return {
    id: "mock",
    getModel: () => "mock-model",
    getMaxTokens: () => 1000,
    async chat(
      params: { messages: Message[]; tools?: ChatToolDef[] },
      callbacks?: StreamCallbacks,
    ): Promise<StreamResult> {
      const agent = detectAgent(params.messages);
      const idx = counts.get(agent) ?? 0;
      counts.set(agent, idx + 1);
      const res = fn(agent, idx, params.messages);
      if (res.assistantText && callbacks?.onContent) {
        callbacks.onContent(res.assistantText);
      }
      return res;
    },
  };
}

/** Wire up bus + tool executor + mq extension + agents extension. */
function harness(
  provider: LLMProvider & { getModel(): string; getMaxTokens(): number },
) {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const registry = new ToolRegistry();
  createToolExecutor(bus, registry);

  const api = {
    registerTool: (t: Tool) => registry.register(t),
    unregisterTool: (n: string) => registry.unregister(n),
    bus,
    getProvider: () => provider,
    getRegistry: () => registry,
    getRuntime: () => runtime,
    getAgentId: () => "main",
    getCwd: () => "/tmp",
    isSubAgent: () => false,
  };

  mqExtension.activate(api);
  agentsExtension.activate(api);

  return { bus, runtime, registry };
}

const txt = (t: string): StreamResult => ({
  toolCalls: [],
  assistantText: t,
  usage: null,
});

const call = (
  id: string,
  name: string,
  args: Record<string, unknown>,
): StreamResult => ({
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  assistantText: "",
  usage: null,
});

// --- Integration tests ---

test("spawn → sub-agent completes → main agent re-activated via bus", async () => {
  const provider = mockProvider((agent, idx) => {
    if (agent === "main") {
      if (idx === 0) return call("tc1", "spawn_agent", { prompt: "find bugs" });
      if (idx === 1) return txt("Spawned, waiting.");
      if (idx === 2) return txt("Got the result.");
      throw new Error(`Unexpected main call #${idx}`);
    }
    return txt("Found 3 bugs in auth.ts");
  });

  const { bus, runtime, registry } = harness(provider);
  new Agent("main", bus, runtime, provider, registry, "You are the main agent.");

  const completed: { agentId: string; result: string }[] = [];
  bus.on("agent:completed", (p) => completed.push(p));

  const mainDone: string[] = [];
  bus.on("llm:done", (p) => {
    if (p.agentId === "main") mainDone.push(p.text);
  });

  bus.emit("user:input", { agentId: "main", text: "find bugs" });

  await waitFor(() => mainDone.length >= 2);

  expect(completed.length).toBe(1);
  expect(completed[0].result).toBe("Found 3 bugs in auth.ts");

  // Main agent was re-activated by the runtime delivering an agent_completed envelope.
  expect(mainDone[0]).toBe("Spawned, waiting.");
  expect(mainDone[1]).toBe("Got the result.");
});

test("sub-agent calls mq_send → agent:message fires on bus", async () => {
  const provider = mockProvider((agent, idx) => {
    if (agent === "main") {
      if (idx === 0)
        return call("tc1", "spawn_agent", { prompt: "search files" });
      if (idx === 1) return txt("Spawned.");
      if (idx === 2) return txt("Got update.");
      throw new Error(`Unexpected main call #${idx}`);
    }
    // Sub-agent: call mq_send then finish
    if (idx === 0)
      return call("tc2", "mq_send", { to: "main", body: "found 5 files" });
    return txt("done searching");
  });

  const { bus, runtime, registry } = harness(provider);
  new Agent("main", bus, runtime, provider, registry, "You are main.");

  const mqMessages: { from: string; to: string; body: string }[] = [];
  bus.on("agent:message", (p) => mqMessages.push(p));

  const completed: string[] = [];
  bus.on("agent:completed", (p) => completed.push(p.result));

  bus.emit("user:input", { agentId: "main", text: "go" });

  await waitFor(() => completed.length >= 1);

  const msg = mqMessages.find((m) => m.body === "found 5 files");
  expect(msg).toBeDefined();
  expect(msg!.to).toBe("main");
  expect(completed[0]).toBe("done searching");
});

test("sub-agent LLM error → agent:error → main agent notified via bus", async () => {
  const provider = mockProvider((agent, idx) => {
    if (agent === "main") {
      if (idx === 0)
        return call("tc1", "spawn_agent", { prompt: "fail task" });
      if (idx === 1) return txt("Spawned.");
      if (idx === 2) return txt("Agent failed, noted.");
      throw new Error(`Unexpected main call #${idx}`);
    }
    throw new Error("Connection refused");
  });

  const { bus, runtime, registry } = harness(provider);
  new Agent("main", bus, runtime, provider, registry, "You are main.");

  const errors: { agentId: string; error: string }[] = [];
  bus.on("agent:error", (p) => errors.push(p));

  const mainDone: string[] = [];
  bus.on("llm:done", (p) => {
    if (p.agentId === "main") mainDone.push(p.text);
  });

  bus.emit("user:input", { agentId: "main", text: "go" });

  await waitFor(() => mainDone.length >= 2);

  expect(errors.length).toBe(1);
  expect(errors[0].error).toContain("Connection refused");
  expect(mainDone[1]).toBe("Agent failed, noted.");
});

test("get_agent_result returns sub-agent output after completion", async () => {
  let spawnedId = "";

  const provider = mockProvider((agent, idx) => {
    if (agent === "main") {
      if (idx === 0)
        return call("tc1", "spawn_agent", { prompt: "analyze code" });
      if (idx === 1) return txt("Spawned.");
      // After sub-agent completion notification arrives:
      if (idx === 2)
        return call("tc2", "get_agent_result", { agent_id: spawnedId });
      if (idx === 3) return txt("Got it.");
      throw new Error(`Unexpected main call #${idx}`);
    }
    return txt("Analysis: no issues found");
  });

  const { bus, runtime, registry } = harness(provider);
  bus.on("agent:spawned", (p) => {
    spawnedId = p.agentId;
  });

  new Agent("main", bus, runtime, provider, registry, "Main agent.");

  const toolResults: { name: string; result: string }[] = [];
  bus.on("tool:result", (p) => {
    if (p.agentId === "main") toolResults.push({ name: p.name, result: p.result });
  });

  const mainDone: string[] = [];
  bus.on("llm:done", (p) => {
    if (p.agentId === "main") mainDone.push(p.text);
  });

  bus.emit("user:input", { agentId: "main", text: "go" });

  await waitFor(() => mainDone.length >= 2);

  const getResult = toolResults.find((r) => r.name === "get_agent_result");
  expect(getResult).toBeDefined();
  const parsed = JSON.parse(getResult!.result);
  expect(parsed.result).toBe("Analysis: no issues found");
});

test("agent:completed handles empty assistantText without crashing", async () => {
  let completionMessages: Message[] = [];
  const provider = mockProvider((agent, idx, messages) => {
    if (agent === "main") {
      if (idx === 0)
        return call("tc1", "spawn_agent", { prompt: "empty task" });
      if (idx === 1) return txt("Spawned.");
      if (idx === 2) {
        completionMessages = [...messages];
        return txt("Got it.");
      }
      throw new Error(`Unexpected main call #${idx}`);
    }
    // Sub-agent returns empty text
    return { toolCalls: [], assistantText: "", usage: null };
  });

  const { bus, runtime, registry } = harness(provider);
  new Agent("main", bus, runtime, provider, registry, "Main agent.");

  const completed: string[] = [];
  bus.on("agent:completed", (p) => completed.push(p.result));

  const mainDone: string[] = [];
  bus.on("llm:done", (p) => {
    if (p.agentId === "main") mainDone.push(p.text);
  });

  bus.emit("user:input", { agentId: "main", text: "go" });

  await waitFor(() => mainDone.length >= 2);

  expect(completed).toEqual([""]);
  expect(completionMessages.some((m) => typeof m.content === "string" && m.content.includes("(no output)"))).toBe(true);
});

test("two sub-agents spawned concurrently → both complete → main gets both notifications", async () => {
  const provider = mockProvider((agent, idx, messages) => {
    if (agent === "main") {
      if (idx === 0)
        return {
          toolCalls: [
            {
              id: "tc1",
              name: "spawn_agent",
              arguments: JSON.stringify({ prompt: "task A" }),
            },
            {
              id: "tc2",
              name: "spawn_agent",
              arguments: JSON.stringify({ prompt: "task B" }),
            },
          ],
          assistantText: "",
          usage: null,
        };
      if (idx === 1) return txt("Both spawned.");
      if (idx === 2) return txt("First done.");
      if (idx === 3) return txt("Second done.");
      throw new Error(`Unexpected main call #${idx}`);
    }
    // Distinguish sub-agents by their user message content
    const userMsg = messages.find((m) => m.role === "user");
    const content =
      typeof userMsg?.content === "string" ? userMsg.content : "";
    if (content.includes("task A")) return txt("Result A");
    return txt("Result B");
  });

  const { bus, runtime, registry } = harness(provider);
  new Agent("main", bus, runtime, provider, registry, "Main agent.");

  const completedResults: string[] = [];
  bus.on("agent:completed", (p) => completedResults.push(p.result));

  const mainDone: string[] = [];
  bus.on("llm:done", (p) => {
    if (p.agentId === "main") mainDone.push(p.text);
  });

  bus.emit("user:input", { agentId: "main", text: "spawn two agents" });

  await waitFor(() => mainDone.length >= 3);

  expect(completedResults).toContain("Result A");
  expect(completedResults).toContain("Result B");
  expect(mainDone).toEqual(["Both spawned.", "First done.", "Second done."]);
});

test("sub-agent MQ broadcast fires agent:message on bus", async () => {
  const provider = mockProvider((agent, idx) => {
    if (agent === "main") {
      if (idx === 0)
        return call("tc1", "spawn_agent", { prompt: "broadcast task" });
      if (idx === 1) return txt("Spawned.");
      if (idx === 2) return txt("Done.");
      throw new Error(`Unexpected main call #${idx}`);
    }
    if (idx === 0)
      return call("tc2", "mq_send", { to: "broadcast", body: "hello all" });
    return txt("broadcasted");
  });

  const { bus, runtime, registry } = harness(provider);
  new Agent("main", bus, runtime, provider, registry, "Main agent.");

  const mqEvents: { from: string; to: string; body: string }[] = [];
  bus.on("agent:message", (p) => mqEvents.push(p));

  const completed: string[] = [];
  bus.on("agent:completed", (p) => completed.push(p.result));

  bus.emit("user:input", { agentId: "main", text: "go" });

  await waitFor(() => completed.length >= 1);

  const broadcast = mqEvents.find((m) => m.body === "hello all");
  expect(broadcast).toBeDefined();
  expect(broadcast!.to).toBe("broadcast");
});
