import type { MessageBus } from "../mq/bus.ts";
import type { ToolRegistry } from "./tool-registry.ts";

export function createToolExecutor(bus: MessageBus, registry: ToolRegistry) {
  bus.on("tool:call", async ({ agentId, callId, name, args }) => {
    try {
      const ctx = { cwd: process.cwd(), agentId, isSubAgent: agentId !== "main" };
      const result = await registry.execute(name, args, ctx);
      bus.emit("tool:result", { agentId, callId, name, result });
    } catch (err) {
      bus.emit("tool:error", { agentId, callId, name, error: String(err) });
    }
  });
}
