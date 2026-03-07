import type { Extension } from "../../harness/types.ts";
import type { Tool } from "../../agent/tool.ts";
import type { ActorRuntime, AgentMessageRecord } from "../../runtime/actor-runtime.ts";

export type MqMessage = AgentMessageRecord;

export function sendMessage(runtime: ActorRuntime, from: string, to: string, body: string): void {
  runtime.sendAgentMessage(from, to, body);
}

export function readMessages(runtime: ActorRuntime, agentId: string, since?: string): MqMessage[] {
  return runtime.readMessages(agentId, since);
}

export function readAllMessages(runtime: ActorRuntime, since?: string): MqMessage[] {
  return runtime.readAllMessages(since);
}

const mqSend: Tool = {
  definition: {
    name: "mq_send",
    description:
      'Send a message to another agent via the actor mailbox system. Use "main" to message the main agent, an agent ID like "a001" for a sub-agent, or "broadcast" for all active agents.',
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description:
            'Recipient agent ID ("main", "a001", etc.) or "broadcast"',
        },
        body: {
          type: "string",
          description: "Message content",
        },
      },
      required: ["to", "body"],
    },
  },
  async execute() {
    return JSON.stringify({ sent: false, error: "mq_send is not initialized" });
  },
};

const mqRead: Tool = {
  definition: {
    name: "mq_read",
    description:
      "Read message history addressed to you or delivered via broadcast. Optionally filter by timestamp.",
    parameters: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description:
            "ISO timestamp — only return messages after this time (optional)",
        },
      },
    },
  },
  async execute() {
    return JSON.stringify([]);
  },
};

export const mqExtension: Extension = {
  name: "mq",
  activate(api) {
    const runtime = api.getRuntime();

    const runtimeMqSend: Tool = {
      ...mqSend,
      async execute(args, ctx) {
        const to = args.to as string;
        const body = args.body as string;
        runtime.sendAgentMessage(ctx.agentId, to, body);
        return JSON.stringify({ sent: true, from: ctx.agentId, to });
      },
    };

    const runtimeMqRead: Tool = {
      ...mqRead,
      async execute(args, ctx) {
        const since = args.since as string | undefined;
        return JSON.stringify(runtime.readMessages(ctx.agentId, since));
      },
    };

    api.registerTool(runtimeMqSend);
    api.registerTool(runtimeMqRead);
  },
};
