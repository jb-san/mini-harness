import { test, expect } from "bun:test";
import { MessageBus } from "../mq/bus.ts";
import { createStore, connectBusBridge } from "./bus-bridge.ts";

function freshStore(): ReturnType<typeof createStore> {
  return createStore({
    thinkingText: "",
    thinkingActive: false,
    chatLog: [],
    activityLog: [],
    toolLog: [],
    agentSummaries: [],
    model: "",
    tokensUsed: 0,
    maxTokens: 0,
    streaming: false,
    stats: {
      runningAgents: 0,
      completedAgents: 0,
      erroredAgents: 0,
      totalMessages: 0,
      totalToolCalls: 0,
      totalToolErrors: 0,
    },
  });
}

test("llm:chunk:content updates chat log with assistant entry", () => {
  const bus = new MessageBus();
  const store = freshStore();
  connectBusBridge(bus, store);

  bus.emit("llm:chunk:content", { agentId: "main", text: "Hello" });
  bus.emit("llm:chunk:content", { agentId: "main", text: " world" });

  const chatLog = store.getState().chatLog;
  expect(chatLog.length).toBe(1);
  expect(chatLog[0].type).toBe("assistant");
  if (chatLog[0].type === "assistant") {
    expect(chatLog[0].text).toBe("Hello world");
  }
});

test("llm:chunk:reasoning updates thinking text", () => {
  const bus = new MessageBus();
  const store = freshStore();
  connectBusBridge(bus, store);

  bus.emit("llm:chunk:reasoning", { agentId: "main", text: "Thinking..." });

  expect(store.getState().thinkingText).toBe("Thinking...");
  expect(store.getState().thinkingActive).toBe(true);
});

test("llm:done resets streaming state", () => {
  const bus = new MessageBus();
  const store = freshStore();
  connectBusBridge(bus, store);

  bus.emit("llm:chunk:content", { agentId: "main", text: "Hi" });
  expect(store.getState().streaming).toBe(true);

  bus.emit("llm:done", { agentId: "main", text: "Hi", usage: null });
  expect(store.getState().streaming).toBe(false);
  expect(store.getState().thinkingActive).toBe(false);
  expect(store.getState().thinkingText).toBe("");
});

test("tool:call routes to tool log and summary", () => {
  const bus = new MessageBus();
  const store = freshStore();
  connectBusBridge(bus, store);

  bus.emit("tool:call", {
    agentId: "main",
    callId: "c1",
    name: "read_file",
    args: { path: "test.txt" },
  });

  expect(store.getState().chatLog.length).toBe(0);
  expect(store.getState().toolLog.length).toBe(1);
  expect(store.getState().toolLog[0].name).toBe("read_file");
  expect(store.getState().stats.totalToolCalls).toBe(1);
  expect(store.getState().agentSummaries[0]?.toolCalls).toBe(1);
});

test("tool:error increments error counters", () => {
  const bus = new MessageBus();
  const store = freshStore();
  connectBusBridge(bus, store);

  bus.emit("tool:error", {
    agentId: "a001",
    callId: "c1",
    name: "run_shell",
    error: "Command failed",
  });

  expect(store.getState().toolLog.length).toBe(1);
  expect(store.getState().toolLog[0].phase).toBe("error");
  expect(store.getState().stats.totalToolErrors).toBe(1);
  const summary = store.getState().agentSummaries.find((entry) => entry.agentId === "a001");
  expect(summary?.toolErrors).toBe(1);
});

test("context:update updates model info", () => {
  const bus = new MessageBus();
  const store = freshStore();
  connectBusBridge(bus, store);

  bus.emit("context:update", {
    agentId: "main",
    model: "gpt-4",
    tokensUsed: 500,
    maxTokens: 8000,
  });

  expect(store.getState().model).toBe("gpt-4");
  expect(store.getState().tokensUsed).toBe(500);
  expect(store.getState().maxTokens).toBe(8000);
});

test("agent:spawned creates summary and activity entry", () => {
  const bus = new MessageBus();
  const store = freshStore();
  connectBusBridge(bus, store);

  bus.emit("agent:spawned", {
    agentId: "a001",
    parentId: "main",
    prompt: "Do something",
  });

  expect(store.getState().activityLog.length).toBe(1);
  expect(store.getState().activityLog[0].type).toBe("status");
  const summary = store.getState().agentSummaries.find((entry) => entry.agentId === "a001");
  expect(summary?.status).toBe("running");
  expect(summary?.promptPreview).toContain("Do something");
});

test("agent:message updates timeline and counters", () => {
  const bus = new MessageBus();
  const store = freshStore();
  connectBusBridge(bus, store);

  bus.emit("agent:message", { from: "a001", to: "main", body: "Done!" });

  expect(store.getState().activityLog.length).toBe(1);
  expect(store.getState().activityLog[0].type).toBe("message");
  expect(store.getState().stats.totalMessages).toBe(1);
  const fromSummary = store.getState().agentSummaries.find((entry) => entry.agentId === "a001");
  const mainSummary = store.getState().agentSummaries.find((entry) => entry.agentId === "main");
  expect(fromSummary?.messagesSent).toBe(1);
  expect(mainSummary?.messagesReceived).toBe(1);
});

test("hook:event appears in telemetry timeline", () => {
  const bus = new MessageBus();
  const store = freshStore();
  connectBusBridge(bus, store);

  bus.emit("hook:event", {
    status: "blocked",
    hook: "beforeToolCall",
    source: "/tmp/tools.ts",
    detail: "shell blocked",
  });

  expect(store.getState().activityLog.length).toBe(1);
  expect(store.getState().activityLog[0].type).toBe("status");
});

test("sub-agent events stay out of main chat but appear in telemetry", () => {
  const bus = new MessageBus();
  const store = freshStore();
  connectBusBridge(bus, store);

  bus.emit("llm:chunk:content", { agentId: "a001", text: "sub-agent output" });
  bus.emit("tool:call", { agentId: "a001", callId: "c1", name: "x", args: {} });

  expect(store.getState().chatLog.length).toBe(0);
  expect(store.getState().toolLog.length).toBe(1);
});

test("llm:error adds system entry to chat", () => {
  const bus = new MessageBus();
  const store = freshStore();
  connectBusBridge(bus, store);

  bus.emit("llm:error", { agentId: "main", error: "boom" });

  expect(store.getState().chatLog.length).toBe(1);
  expect(store.getState().chatLog[0].type).toBe("system");
});

test("addUserMessage adds user entry and resets thinking", () => {
  const bus = new MessageBus();
  const store = freshStore();
  const bridge = connectBusBridge(bus, store);

  bus.emit("llm:chunk:reasoning", { agentId: "main", text: "thinking" });
  expect(store.getState().thinkingActive).toBe(true);

  bridge.addUserMessage("hello");

  expect(store.getState().thinkingActive).toBe(false);
  expect(store.getState().thinkingText).toBe("");
  expect(store.getState().chatLog.length).toBe(1);
  expect(store.getState().chatLog[0].type).toBe("user");
});
