import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MessageBus } from "../mq/bus.ts";
import { HookManager } from "./manager.ts";

let tempRoot = "";

declare global {
  // eslint-disable-next-line no-var
  var __miniHarnessHookLog: string[] | undefined;
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mini-harness-hooks-"));
  globalThis.__miniHarnessHookLog = [];
});

afterEach(async () => {
  delete globalThis.__miniHarnessHookLog;
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function writeHook(relativePath: string, content: string) {
  const fullPath = join(tempRoot, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
}

test("beforeToolCall hook can block execution", async () => {
  await writeHook(
    ".mini-harness/hooks/tools.ts",
    `
      export async function beforeToolCall(event) {
        if (event.name === "run_shell") return { allow: false, reason: "shell blocked" };
      }
    `,
  );

  const bus = new MessageBus();
  const manager = await HookManager.load(tempRoot, bus);
  const decision = await manager.beforeToolCall({
    agentId: "main",
    callId: "c1",
    name: "run_shell",
    args: {},
    cwd: tempRoot,
    isSubAgent: false,
  });

  expect(decision.allow).toBe(false);
  expect(decision.reason).toBe("shell blocked");
});

test("context hooks receive updates and increases", async () => {
  await writeHook(
    ".mini-harness/hooks/context.ts",
    `
      export async function onContextUpdate(event) {
        globalThis.__miniHarnessHookLog.push("update:" + event.utilizationPercent);
      }

      export async function onContextIncrease(currentContextSize) {
        globalThis.__miniHarnessHookLog.push("increase:" + currentContextSize);
      }
    `,
  );

  const manager = await HookManager.load(tempRoot);

  await manager.onContextUpdate({
    agentId: "main",
    model: "x",
    tokensUsed: 10,
    maxTokens: 100,
  });

  await manager.onContextUpdate({
    agentId: "main",
    model: "x",
    tokensUsed: 25,
    maxTokens: 100,
  });

  await manager.onContextUpdate({
    agentId: "main",
    model: "x",
    tokensUsed: 20,
    maxTokens: 100,
  });

  expect(globalThis.__miniHarnessHookLog).toEqual([
    "update:10",
    "update:25",
    "increase:25",
    "update:20",
  ]);
});

test("hook failures are isolated and reported on the bus", async () => {
  await writeHook(
    ".mini-harness/hooks/tools.ts",
    `
      export async function afterToolCall() {
        throw new Error("hook blew up");
      }
    `,
  );

  const bus = new MessageBus();
  const manager = await HookManager.load(tempRoot, bus);
  const events: string[] = [];
  bus.on("hook:event", (event) => {
    if (event.status === "error") events.push(event.detail);
  });

  await manager.afterToolCall({
    agentId: "main",
    callId: "c1",
    name: "read_file",
    args: {},
    cwd: tempRoot,
    isSubAgent: false,
    result: "ok",
  });

  expect(events.some((detail) => detail.includes("hook blew up"))).toBe(true);
});
