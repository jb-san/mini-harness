import { test, expect } from "bun:test";
import { MessageBus } from "../mq/bus.ts";
import { Agent } from "./agent.ts";
import { ToolRegistry } from "./tool-registry.ts";
import type { LLMProvider } from "../ai/provider.ts";
import type { Message, ChatToolDef, StreamCallbacks, StreamResult } from "../ai/types.ts";
import { ActorRuntime } from "../runtime/actor-runtime.ts";

function createMockProvider(responses: StreamResult[]): LLMProvider & { getModel(): string; getMaxTokens(): number } {
  let callIndex = 0;
  return {
    id: "mock",
    getModel: () => "mock-model",
    getMaxTokens: () => 1000,
    async chat(params: { messages: Message[]; tools?: ChatToolDef[] }, callbacks?: StreamCallbacks): Promise<StreamResult> {
      const response = responses[callIndex++];
      if (!response) throw new Error("No more mock responses");
      // Simulate streaming callbacks
      if (response.assistantText && callbacks?.onContent) {
        callbacks.onContent(response.assistantText);
      }
      return response;
    },
  };
}

test("Agent handles simple text response", async () => {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const registry = new ToolRegistry();
  const provider = createMockProvider([
    { toolCalls: [], assistantText: "Hello!", usage: null },
  ]);

  const doneMessages: string[] = [];
  bus.on("llm:done", (p) => doneMessages.push(p.text));

  const contentChunks: string[] = [];
  bus.on("llm:chunk:content", (p) => contentChunks.push(p.text));

  const agent = new Agent("main", bus, runtime, provider, registry, "You are helpful.");

  bus.emit("user:input", { agentId: "main", text: "Hi" });

  // Give async handler time to complete
  await new Promise((r) => setTimeout(r, 50));

  expect(doneMessages).toEqual(["Hello!"]);
  expect(contentChunks).toEqual(["Hello!"]);
});

test("Agent handles tool call -> tool result -> final response", async () => {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const registry = new ToolRegistry();

  const provider = createMockProvider([
    // First response: tool call
    {
      toolCalls: [{ id: "tc1", name: "read_file", arguments: '{"path":"test.txt"}' }],
      assistantText: "",
      usage: null,
    },
    // Second response: text
    {
      toolCalls: [],
      assistantText: "File contents: hello",
      usage: null,
    },
  ]);

  const toolCalls: string[] = [];
  bus.on("tool:call", (p) => {
    toolCalls.push(p.name);
    // Simulate tool executor responding
    bus.emit("tool:result", {
      agentId: p.agentId,
      callId: p.callId,
      name: p.name,
      result: "hello",
    });
  });

  const doneMessages: string[] = [];
  bus.on("llm:done", (p) => doneMessages.push(p.text));

  const agent = new Agent("main", bus, runtime, provider, registry, "You are helpful.");

  bus.emit("user:input", { agentId: "main", text: "Read test.txt" });

  await new Promise((r) => setTimeout(r, 50));

  expect(toolCalls).toEqual(["read_file"]);
  expect(doneMessages).toEqual(["File contents: hello"]);
});

test("Agent ignores input for other agent IDs", async () => {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const registry = new ToolRegistry();
  const provider = createMockProvider([
    { toolCalls: [], assistantText: "Hello!", usage: null },
  ]);

  const doneMessages: string[] = [];
  bus.on("llm:done", (p) => doneMessages.push(p.text));

  const agent = new Agent("main", bus, runtime, provider, registry, "You are helpful.");

  // Send input to a different agent
  bus.emit("user:input", { agentId: "a001", text: "Hi" });

  await new Promise((r) => setTimeout(r, 50));

  expect(doneMessages).toEqual([]);
});

test("Agent queues input during thinking", async () => {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const registry = new ToolRegistry();

  let resolveFirst: ((result: StreamResult) => void) | null = null;
  let callCount = 0;

  const provider: LLMProvider & { getModel(): string; getMaxTokens(): number } = {
    id: "mock",
    getModel: () => "mock-model",
    getMaxTokens: () => 1000,
    async chat(params, callbacks) {
      callCount++;
      if (callCount === 1) {
        // First call: block until we resolve
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      // Second call: immediate response
      return { toolCalls: [], assistantText: "Second response", usage: null };
    },
  };

  const doneMessages: string[] = [];
  bus.on("llm:done", (p) => doneMessages.push(p.text));

  const agent = new Agent("main", bus, runtime, provider, registry, "You are helpful.");

  bus.emit("user:input", { agentId: "main", text: "First" });
  await new Promise((r) => setTimeout(r, 10));

  // Agent is thinking — this should be queued
  bus.emit("user:input", { agentId: "main", text: "Second" });

  // Resolve first call
  resolveFirst!({ toolCalls: [], assistantText: "First response", usage: null });

  await new Promise((r) => setTimeout(r, 100));

  expect(doneMessages).toEqual(["First response", "Second response"]);
});

test("Agent emits llm:error on provider failure", async () => {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const registry = new ToolRegistry();

  const provider: LLMProvider & { getModel(): string; getMaxTokens(): number } = {
    id: "mock",
    getModel: () => "mock-model",
    getMaxTokens: () => 1000,
    async chat() {
      throw new Error("Connection refused");
    },
  };

  const errors: string[] = [];
  bus.on("llm:error", (p) => errors.push(p.error));

  const agent = new Agent("main", bus, runtime, provider, registry, "You are helpful.");

  bus.emit("user:input", { agentId: "main", text: "Hi" });

  await new Promise((r) => setTimeout(r, 50));

  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("Connection refused");
});

test("Agent emits context:update when usage is present", async () => {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const registry = new ToolRegistry();
  const provider = createMockProvider([
    {
      toolCalls: [],
      assistantText: "Hello!",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);

  const updates: { tokensUsed: number }[] = [];
  bus.on("context:update", (p) => updates.push({ tokensUsed: p.tokensUsed }));

  const agent = new Agent("main", bus, runtime, provider, registry, "You are helpful.");

  bus.emit("user:input", { agentId: "main", text: "Hi" });

  await new Promise((r) => setTimeout(r, 50));

  expect(updates).toEqual([{ tokensUsed: 15 }]);
});

test("Agent.send() defers processing to next macrotask", async () => {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const registry = new ToolRegistry();
  let chatCalled = false;

  const provider: LLMProvider & { getModel(): string; getMaxTokens(): number } = {
    id: "mock",
    getModel: () => "mock-model",
    getMaxTokens: () => 1000,
    async chat() {
      chatCalled = true;
      return { toolCalls: [], assistantText: "Done", usage: null };
    },
  };

  const agent = new Agent("main", bus, runtime, provider, registry, "You are helpful.");

  agent.send("hello");

  // provider.chat should NOT have been called synchronously
  expect(chatCalled).toBe(false);

  // After yielding to the macrotask, it should run
  await new Promise((r) => setTimeout(r, 50));
  expect(chatCalled).toBe(true);
});

test("Agent handles tool:error response", async () => {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const registry = new ToolRegistry();

  const provider = createMockProvider([
    {
      toolCalls: [{ id: "tc1", name: "run_shell", arguments: '{"command":"fail"}' }],
      assistantText: "",
      usage: null,
    },
    {
      toolCalls: [],
      assistantText: "Tool failed",
      usage: null,
    },
  ]);

  bus.on("tool:call", (p) => {
    bus.emit("tool:error", {
      agentId: p.agentId,
      callId: p.callId,
      name: p.name,
      error: "Command failed",
    });
  });

  const doneMessages: string[] = [];
  bus.on("llm:done", (p) => doneMessages.push(p.text));

  const agent = new Agent("main", bus, runtime, provider, registry, "You are helpful.");

  bus.emit("user:input", { agentId: "main", text: "Run fail" });

  await new Promise((r) => setTimeout(r, 50));

  expect(doneMessages).toEqual(["Tool failed"]);
});
