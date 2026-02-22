import { readdir, mkdir } from "fs/promises";
import type { Tool } from "./index";

const MQ_DIR = ".mini-harness/mq";

let _currentAgentId = "main";

export function setMqAgentId(id: string) {
  _currentAgentId = id;
}

async function ensureMqDir() {
  await mkdir(MQ_DIR, { recursive: true });
}

async function nextMessageId(): Promise<string> {
  await ensureMqDir();
  const files = await readdir(MQ_DIR);
  let max = 0;
  for (const f of files) {
    const num = parseInt(f.replace(/\.json$/, ""), 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return String(max + 1).padStart(4, "0");
}

export interface MqMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
}

export async function readMessages(
  forAgent: string,
  since?: string,
): Promise<MqMessage[]> {
  await ensureMqDir();
  const files = (await readdir(MQ_DIR)).filter((f) => f.endsWith(".json")).sort();
  const messages: MqMessage[] = [];

  for (const f of files) {
    const msg: MqMessage = await Bun.file(`${MQ_DIR}/${f}`).json();
    if (msg.to !== forAgent && msg.to !== "broadcast") continue;
    if (since && msg.timestamp <= since) continue;
    messages.push(msg);
  }

  return messages;
}

export async function readAllMessages(since?: string): Promise<MqMessage[]> {
  await ensureMqDir();
  const files = (await readdir(MQ_DIR)).filter((f) => f.endsWith(".json")).sort();
  const messages: MqMessage[] = [];

  for (const f of files) {
    try {
      const msg: MqMessage = await Bun.file(`${MQ_DIR}/${f}`).json();
      if (since && msg.timestamp <= since) continue;
      messages.push(msg);
    } catch {
      // skip malformed
    }
  }

  return messages;
}

export const mq_send: Tool = {
  definition: {
    type: "function",
    name: "mq_send",
    description:
      'Send a message to another agent via the message queue. Use "main" to message the main agent, an agent ID like "a001" for a sub-agent, or "broadcast" for all agents.',
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
  async execute(args) {
    const to = args.to as string;
    const body = args.body as string;
    const id = await nextMessageId();

    const msg: MqMessage = {
      id,
      from: _currentAgentId,
      to,
      body,
      timestamp: new Date().toISOString(),
    };

    await Bun.write(`${MQ_DIR}/${id}.json`, JSON.stringify(msg, null, 2));
    return JSON.stringify({ sent: true, id, from: _currentAgentId, to });
  },
};

export const mq_read: Tool = {
  definition: {
    type: "function",
    name: "mq_read",
    description:
      "Read messages from the message queue addressed to you or broadcast. Optionally filter by timestamp.",
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
  async execute(args) {
    const since = args.since as string | undefined;
    const messages = await readMessages(_currentAgentId, since);
    return JSON.stringify(messages);
  },
};
