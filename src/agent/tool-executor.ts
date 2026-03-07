import type { MessageBus } from "../mq/bus.ts";
import type { ToolRegistry } from "./tool-registry.ts";
import type { HookManager } from "../hooks/manager.ts";

export function createToolExecutor(
  bus: MessageBus,
  registry: ToolRegistry,
  hooks?: HookManager,
) {
  bus.on("tool:call", async ({ agentId, callId, name, args }) => {
    const ctx = { cwd: process.cwd(), agentId, isSubAgent: agentId !== "main" };

    const decision = hooks
      ? await hooks.beforeToolCall({ agentId, callId, name, args, ...ctx })
      : { allow: true as const };

    if (!decision.allow) {
      bus.emit("tool:error", {
        agentId,
        callId,
        name,
        error: decision.reason ?? `Tool blocked by hook: ${name}`,
      });
      return;
    }

    try {
      const result = await registry.execute(name, args, ctx);
      if (hooks) {
        await hooks.afterToolCall({ agentId, callId, name, args, ...ctx, result });
      }
      bus.emit("tool:result", { agentId, callId, name, result });
    } catch (err) {
      const error = String(err);
      if (hooks) {
        await hooks.onToolError({ agentId, callId, name, args, ...ctx, error });
      }
      bus.emit("tool:error", { agentId, callId, name, error });
    }
  });
}
