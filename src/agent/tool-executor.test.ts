import { test, expect } from "bun:test";
import { MessageBus } from "../mq/bus.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { createToolExecutor } from "./tool-executor.ts";
import type { Tool } from "./tool.ts";

test("tool executor handles tool:call and emits tool:result", async () => {
  const bus = new MessageBus();
  const registry = new ToolRegistry();

  const echoTool: Tool = {
    definition: { name: "echo", description: "Echo back args" },
    async execute(args) {
      return JSON.stringify(args);
    },
  };
  registry.register(echoTool);

  createToolExecutor(bus, registry);

  const resultPromise = bus.next("tool:result", (p) => p.callId === "c1");

  bus.emit("tool:call", {
    agentId: "main",
    callId: "c1",
    name: "echo",
    args: { message: "hello" },
  });

  const result = await resultPromise;
  expect(result.name).toBe("echo");
  expect(result.result).toBe('{"message":"hello"}');
});

test("tool executor emits tool:error on exception", async () => {
  const bus = new MessageBus();
  const registry = new ToolRegistry();

  const failTool: Tool = {
    definition: { name: "fail", description: "Always fails" },
    async execute() {
      throw new Error("Boom!");
    },
  };
  registry.register(failTool);

  createToolExecutor(bus, registry);

  const errorPromise = bus.next("tool:error", (p) => p.callId === "c2");

  bus.emit("tool:call", {
    agentId: "main",
    callId: "c2",
    name: "fail",
    args: {},
  });

  const error = await errorPromise;
  expect(error.name).toBe("fail");
  expect(error.error).toContain("Boom!");
});

test("tool executor handles unknown tool gracefully", async () => {
  const bus = new MessageBus();
  const registry = new ToolRegistry();

  createToolExecutor(bus, registry);

  const resultPromise = bus.next("tool:result", (p) => p.callId === "c3");

  bus.emit("tool:call", {
    agentId: "main",
    callId: "c3",
    name: "nonexistent",
    args: {},
  });

  const result = await resultPromise;
  expect(result.result).toContain("Unknown tool");
});

test("tool executor passes correct context for sub-agents", async () => {
  const bus = new MessageBus();
  const registry = new ToolRegistry();

  let receivedCtx: any = null;
  const ctxTool: Tool = {
    definition: { name: "check_ctx", description: "Returns context info" },
    async execute(args, ctx) {
      receivedCtx = ctx;
      return JSON.stringify(ctx);
    },
  };
  registry.register(ctxTool);

  createToolExecutor(bus, registry);

  const resultPromise = bus.next("tool:result", (p) => p.callId === "c4");

  bus.emit("tool:call", {
    agentId: "a001",
    callId: "c4",
    name: "check_ctx",
    args: {},
  });

  await resultPromise;
  expect(receivedCtx.agentId).toBe("a001");
  expect(receivedCtx.isSubAgent).toBe(true);
});

test("multiple concurrent tool calls execute in parallel", async () => {
  const bus = new MessageBus();
  const registry = new ToolRegistry();

  const order: string[] = [];
  const slowTool: Tool = {
    definition: { name: "slow", description: "Slow tool" },
    async execute(args) {
      const id = args.id as string;
      order.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end-${id}`);
      return id;
    },
  };
  registry.register(slowTool);

  createToolExecutor(bus, registry);

  const r1 = bus.next("tool:result", (p) => p.callId === "c1");
  const r2 = bus.next("tool:result", (p) => p.callId === "c2");

  bus.emit("tool:call", { agentId: "main", callId: "c1", name: "slow", args: { id: "A" } });
  bus.emit("tool:call", { agentId: "main", callId: "c2", name: "slow", args: { id: "B" } });

  await Promise.all([r1, r2]);

  // Both should start before either ends (parallel execution)
  expect(order[0]).toBe("start-A");
  expect(order[1]).toBe("start-B");
});

test("beforeToolCall hook can block tool execution", async () => {
  const bus = new MessageBus();
  const registry = new ToolRegistry();

  let executed = false;
  registry.register({
    definition: { name: "echo", description: "Echo" },
    async execute() {
      executed = true;
      return "ok";
    },
  });

  const hooks = {
    async beforeToolCall() {
      return { allow: false as const, reason: "blocked by policy" };
    },
    async afterToolCall() {},
    async onToolError() {},
  };

  createToolExecutor(bus, registry, hooks as any);

  const errorPromise = bus.next("tool:error", (p) => p.callId === "c5");
  bus.emit("tool:call", {
    agentId: "main",
    callId: "c5",
    name: "echo",
    args: {},
  });

  const error = await errorPromise;
  expect(executed).toBe(false);
  expect(error.error).toContain("blocked by policy");
});

test("tool executor notifies hooks after success and failure", async () => {
  const bus = new MessageBus();
  const registry = new ToolRegistry();

  const events: string[] = [];

  registry.register({
    definition: { name: "ok", description: "ok" },
    async execute() {
      return "done";
    },
  });

  registry.register({
    definition: { name: "boom", description: "boom" },
    async execute() {
      throw new Error("nope");
    },
  });

  const hooks = {
    async beforeToolCall() {
      return { allow: true as const };
    },
    async afterToolCall(event: any) {
      events.push(`after:${event.name}:${event.result}`);
    },
    async onToolError(event: any) {
      events.push(`error:${event.name}:${event.error}`);
    },
  };

  createToolExecutor(bus, registry, hooks as any);

  const okPromise = bus.next("tool:result", (p) => p.callId === "c6");
  const errPromise = bus.next("tool:error", (p) => p.callId === "c7");

  bus.emit("tool:call", { agentId: "main", callId: "c6", name: "ok", args: {} });
  bus.emit("tool:call", { agentId: "main", callId: "c7", name: "boom", args: {} });

  await Promise.all([okPromise, errPromise]);

  expect(events).toContain("after:ok:done");
  expect(events.some((entry) => entry.startsWith("error:boom:"))).toBe(true);
});
