import { test, expect } from "bun:test";
import { MessageBus } from "../../mq/bus.ts";
import { mqExtension, readMessages, sendMessage } from "./index.ts";
import { ActorRuntime } from "../../runtime/actor-runtime.ts";

test("mq extension registers mq_send and mq_read tools", async () => {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const tools: string[] = [];

  await mqExtension.activate({
    registerTool: (t) => tools.push(t.definition.name),
    unregisterTool: () => {},
    bus,
    getProvider: () => ({} as any),
    getRegistry: () => ({} as any),
    getRuntime: () => runtime,
    getAgentId: () => "main",
    getCwd: () => "/tmp",
    isSubAgent: () => false,
  });

  expect(tools).toEqual(["mq_send", "mq_read"]);
});

test("sendMessage emits agent:message on bus", () => {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const received: any[] = [];
  bus.on("agent:message", (p) => received.push(p));

  sendMessage(runtime, "main", "a001", "hello agent");

  expect(received.length).toBe(1);
  expect(received[0].from).toBe("main");
  expect(received[0].to).toBe("a001");
  expect(received[0].body).toBe("hello agent");
});

test("agent:message populates inbox for recipient", async () => {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);

  await mqExtension.activate({
    registerTool: () => {},
    unregisterTool: () => {},
    bus,
    getProvider: () => ({} as any),
    getRegistry: () => ({} as any),
    getRuntime: () => runtime,
    getAgentId: () => "main",
    getCwd: () => "/tmp",
    isSubAgent: () => false,
  });

  const before = readMessages(runtime, "main").length;
  runtime.sendAgentMessage("a001", "main", "report");

  const msgs = readMessages(runtime, "main");
  expect(msgs.length).toBe(before + 1);
  const last = msgs[msgs.length - 1];
  expect(last.from).toBe("a001");
  expect(last.body).toBe("report");
});
