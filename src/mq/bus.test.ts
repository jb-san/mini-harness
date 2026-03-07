import { test, expect } from "bun:test";
import { MessageBus } from "./bus.ts";

test("on + emit delivers to subscriber", () => {
  const bus = new MessageBus();
  const received: string[] = [];

  bus.on("user:input", (payload) => {
    received.push(payload.text);
  });

  bus.emit("user:input", { agentId: "main", text: "hello" });
  bus.emit("user:input", { agentId: "main", text: "world" });

  expect(received).toEqual(["hello", "world"]);
});

test("on returns unsubscribe function", () => {
  const bus = new MessageBus();
  const received: string[] = [];

  const unsub = bus.on("user:input", (payload) => {
    received.push(payload.text);
  });

  bus.emit("user:input", { agentId: "main", text: "before" });
  unsub();
  bus.emit("user:input", { agentId: "main", text: "after" });

  expect(received).toEqual(["before"]);
});

test("multiple subscribers receive same event", () => {
  const bus = new MessageBus();
  let count = 0;

  bus.on("llm:done", () => { count++; });
  bus.on("llm:done", () => { count++; });

  bus.emit("llm:done", { agentId: "main", text: "done", usage: null });

  expect(count).toBe(2);
});

test("next resolves on matching emit", async () => {
  const bus = new MessageBus();

  const promise = bus.next("tool:result");
  bus.emit("tool:result", { agentId: "main", callId: "c1", name: "read_file", result: "ok" });

  const result = await promise;
  expect(result.callId).toBe("c1");
  expect(result.result).toBe("ok");
});

test("next with filter only resolves on matching payload", async () => {
  const bus = new MessageBus();

  const promise = bus.next("tool:result", (p) => p.callId === "c2");

  // This one shouldn't match
  bus.emit("tool:result", { agentId: "main", callId: "c1", name: "a", result: "no" });
  // This one should match
  bus.emit("tool:result", { agentId: "main", callId: "c2", name: "b", result: "yes" });

  const result = await promise;
  expect(result.callId).toBe("c2");
  expect(result.result).toBe("yes");
});

test("next is one-shot — doesn't resolve twice", async () => {
  const bus = new MessageBus();

  const promise = bus.next("user:input");
  bus.emit("user:input", { agentId: "main", text: "first" });
  bus.emit("user:input", { agentId: "main", text: "second" });

  const result = await promise;
  expect(result.text).toBe("first");
});

test("emit with no subscribers doesn't throw", () => {
  const bus = new MessageBus();
  expect(() => {
    bus.emit("llm:error", { agentId: "main", error: "oops" });
  }).not.toThrow();
});

test("on and next work together", async () => {
  const bus = new MessageBus();
  const onReceived: string[] = [];

  bus.on("agent:completed", (p) => { onReceived.push(p.result); });
  const nextPromise = bus.next("agent:completed");

  bus.emit("agent:completed", { agentId: "a001", result: "done" });

  expect(onReceived).toEqual(["done"]);
  const nextResult = await nextPromise;
  expect(nextResult.result).toBe("done");
});
