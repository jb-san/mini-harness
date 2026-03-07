import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MessageBus } from "../mq/bus.ts";

const HOOK_TIMEOUT_MS = 2000;

type MaybePromise<T> = T | Promise<T>;

export interface ContextHookEvent {
  agentId: string;
  model: string;
  tokensUsed: number;
  maxTokens: number;
  utilization: number;
  utilizationPercent: number;
  previousUtilization: number | null;
  previousUtilizationPercent: number | null;
}

export interface ToolHookBaseEvent {
  agentId: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  cwd: string;
  isSubAgent: boolean;
}

export interface ToolResultHookEvent extends ToolHookBaseEvent {
  result: string;
}

export interface ToolErrorHookEvent extends ToolHookBaseEvent {
  error: string;
}

export type BeforeToolCallDecision =
  | void
  | { allow?: true }
  | { allow: false; reason?: string };

interface HookModule {
  beforeToolCall?: (event: ToolHookBaseEvent) => MaybePromise<BeforeToolCallDecision>;
  afterToolCall?: (event: ToolResultHookEvent) => MaybePromise<void>;
  onToolError?: (event: ToolErrorHookEvent) => MaybePromise<void>;
  onContextUpdate?: (event: ContextHookEvent) => MaybePromise<void>;
  onContextIncrease?: (
    currentContextSize: number,
    event: ContextHookEvent,
  ) => MaybePromise<void>;
}

interface LoadedHook<T extends keyof HookModule> {
  source: string;
  fn: NonNullable<HookModule[T]>;
}

export class HookManager {
  private beforeToolCallHooks: LoadedHook<"beforeToolCall">[] = [];
  private afterToolCallHooks: LoadedHook<"afterToolCall">[] = [];
  private onToolErrorHooks: LoadedHook<"onToolError">[] = [];
  private onContextUpdateHooks: LoadedHook<"onContextUpdate">[] = [];
  private onContextIncreaseHooks: LoadedHook<"onContextIncrease">[] = [];
  private contextLevels = new Map<string, number>();

  private constructor(
    private root: string,
    private bus?: MessageBus,
  ) {}

  static async load(root: string, bus?: MessageBus): Promise<HookManager> {
    const manager = new HookManager(root, bus);
    await manager.loadKnownModules();
    return manager;
  }

  async beforeToolCall(event: ToolHookBaseEvent): Promise<{ allow: boolean; reason?: string }> {
    for (const hook of this.beforeToolCallHooks) {
      const decision = await this.callHook(hook.source, "beforeToolCall", () => hook.fn(event));
      if (decision && decision.allow === false) {
        const reason = decision.reason?.trim() || `blocked by hook ${hook.source}`;
        this.emitHookEvent("blocked", "beforeToolCall", hook.source, reason);
        return { allow: false, reason };
      }
    }
    return { allow: true };
  }

  async afterToolCall(event: ToolResultHookEvent): Promise<void> {
    await Promise.all(
      this.afterToolCallHooks.map((hook) =>
        this.callHook(hook.source, "afterToolCall", () => hook.fn(event)),
      ),
    );
  }

  async onToolError(event: ToolErrorHookEvent): Promise<void> {
    await Promise.all(
      this.onToolErrorHooks.map((hook) =>
        this.callHook(hook.source, "onToolError", () => hook.fn(event)),
      ),
    );
  }

  async onContextUpdate(event: {
    agentId: string;
    model: string;
    tokensUsed: number;
    maxTokens: number;
  }): Promise<void> {
    const utilization = event.maxTokens > 0 ? event.tokensUsed / event.maxTokens : 0;
    const previous = this.contextLevels.get(event.agentId);

    const payload: ContextHookEvent = {
      ...event,
      utilization,
      utilizationPercent: Math.round(utilization * 100),
      previousUtilization: previous ?? null,
      previousUtilizationPercent: previous == null ? null : Math.round(previous * 100),
    };

    this.contextLevels.set(event.agentId, utilization);

    await Promise.all(
      this.onContextUpdateHooks.map((hook) =>
        this.callHook(hook.source, "onContextUpdate", () => hook.fn(payload)),
      ),
    );

    if (previous == null || utilization <= previous) return;

    await Promise.all(
      this.onContextIncreaseHooks.map((hook) =>
        this.callHook(hook.source, "onContextIncrease", () =>
          hook.fn(payload.utilizationPercent, payload),
        ),
      ),
    );
  }

  private async loadKnownModules(): Promise<void> {
    const files = [
      ".mini-harness/hooks/index.ts",
      ".mini-harness/hooks/index.js",
      ".mini-harness/hooks/context.ts",
      ".mini-harness/hooks/context.js",
      ".mini-harness/hooks/tools.ts",
      ".mini-harness/hooks/tools.js",
    ].map((file) => resolve(this.root, file));

    for (const file of files) {
      if (!(await fileExists(file))) continue;
      await this.loadModule(file);
    }
  }

  private async loadModule(file: string): Promise<void> {
    try {
      const modulePath = `${pathToFileURL(file).href}?t=${Date.now()}`;
      const mod = (await import(modulePath)) as HookModule;
      this.registerHook("beforeToolCall", file, mod.beforeToolCall);
      this.registerHook("afterToolCall", file, mod.afterToolCall);
      this.registerHook("onToolError", file, mod.onToolError);
      this.registerHook("onContextUpdate", file, mod.onContextUpdate);
      this.registerHook("onContextIncrease", file, mod.onContextIncrease);
      this.emitHookEvent("loaded", "module", file, "hook module loaded");
    } catch (error) {
      this.emitHookEvent("error", "module", file, String(error));
    }
  }

  private registerHook<T extends keyof HookModule>(
    name: T,
    source: string,
    fn: HookModule[T] | undefined,
  ): void {
    if (!fn) return;
    const hook = { source, fn: fn as NonNullable<HookModule[T]> };
    switch (name) {
      case "beforeToolCall":
        this.beforeToolCallHooks.push(hook as LoadedHook<"beforeToolCall">);
        break;
      case "afterToolCall":
        this.afterToolCallHooks.push(hook as LoadedHook<"afterToolCall">);
        break;
      case "onToolError":
        this.onToolErrorHooks.push(hook as LoadedHook<"onToolError">);
        break;
      case "onContextUpdate":
        this.onContextUpdateHooks.push(hook as LoadedHook<"onContextUpdate">);
        break;
      case "onContextIncrease":
        this.onContextIncreaseHooks.push(hook as LoadedHook<"onContextIncrease">);
        break;
    }
    this.emitHookEvent("loaded", name, source, `${name} registered`);
  }

  private async callHook<T>(
    source: string,
    hook: string,
    fn: () => MaybePromise<T>,
  ): Promise<T | undefined> {
    try {
      const result = await withTimeout(fn(), HOOK_TIMEOUT_MS, `${hook} timed out`);
      this.emitHookEvent("run", hook, source, `${hook} completed`);
      return result;
    } catch (error) {
      this.emitHookEvent("error", hook, source, String(error));
      return undefined;
    }
  }

  private emitHookEvent(
    status: "loaded" | "run" | "blocked" | "error",
    hook: string,
    source: string,
    detail: string,
  ): void {
    this.bus?.emit("hook:event", { status, hook, source, detail });
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
