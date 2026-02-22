import { createUI } from "./ui";
import { createSession } from "./core";
import { readMessages, readAllMessages } from "./tools/mq";
import { readdir } from "fs/promises";
import type { AgentMeta } from "./tools/agents";

const AGENTS_DIR = ".mini-harness/agents";
const HEARTBEAT_INTERVAL_MS = 30_000;

const { callbacks, waitForInput, addAgentMessage, addAgentStatus } =
  await createUI();
const session = createSession();

// --- Heartbeat state ---
let lastMqCheck = new Date().toISOString();
let lastPanelMqCheck = new Date().toISOString();
const lastAgentStatuses = new Map<string, string>();

interface HeartbeatResult {
  messages: { from: string; body: string }[];
  agentChanges: { id: string; from: string; to: string }[];
}

async function checkHeartbeat(): Promise<HeartbeatResult | null> {
  const result: HeartbeatResult = {
    messages: [],
    agentChanges: [],
  };

  // Check MQ for new messages to "main" (for the agent loop)
  try {
    const msgs = await readMessages("main", lastMqCheck);
    if (msgs.length > 0) {
      lastMqCheck = msgs[msgs.length - 1]!.timestamp;
      result.messages = msgs.map((m) => ({ from: m.from, body: m.body }));
    }
  } catch {
    // MQ dir may not exist yet
  }

  // Feed ALL new MQ messages to the agents panel
  try {
    const allMsgs = await readAllMessages(lastPanelMqCheck);
    if (allMsgs.length > 0) {
      lastPanelMqCheck = allMsgs[allMsgs.length - 1]!.timestamp;
      for (const msg of allMsgs) {
        addAgentMessage(msg.from, msg.to, msg.body, msg.id);
      }
    }
  } catch {
    // MQ dir may not exist yet
  }

  // Check agent status changes
  try {
    const dirs = await readdir(AGENTS_DIR);
    for (const d of dirs) {
      try {
        const meta: AgentMeta = await Bun.file(
          `${AGENTS_DIR}/${d}/meta.json`,
        ).json();
        const prev = lastAgentStatuses.get(meta.id);
        if (prev && prev !== meta.status) {
          result.agentChanges.push({
            id: meta.id,
            from: prev,
            to: meta.status,
          });
          // Also push to the agents panel
          addAgentStatus(meta.id, `${meta.id} ${prev} -> ${meta.status}`);
        } else if (!prev) {
          // First time seeing this agent
          lastAgentStatuses.set(meta.id, meta.status);
          const promptPreview = meta.prompt.slice(0, 60);
          addAgentStatus(
            meta.id,
            `${meta.id} spawned: ${promptPreview}${meta.prompt.length > 60 ? "..." : ""}`,
          );
        }
        lastAgentStatuses.set(meta.id, meta.status);
      } catch {
        // skip malformed
      }
    }
  } catch {
    // agents dir may not exist yet
  }

  if (result.messages.length === 0 && result.agentChanges.length === 0) {
    return null;
  }

  return result;
}

function formatHeartbeatNotification(hb: HeartbeatResult): string {
  const parts: string[] = ["[SYSTEM] Heartbeat notification:"];

  for (const change of hb.agentChanges) {
    parts.push(
      `- Agent ${change.id} changed status: ${change.from} -> ${change.to}`,
    );
  }

  if (hb.messages.length > 0) {
    parts.push(`- ${hb.messages.length} new message(s) in queue for you.`);
    for (const msg of hb.messages) {
      parts.push(`  [from ${msg.from}]: ${msg.body.slice(0, 200)}`);
    }
  }

  parts.push("Use check_agents() and mq_read() for full details.");
  return parts.join("\n");
}

// --- Main loop with heartbeat ---
// Keep a single waitForInput promise alive across heartbeat cycles.
// Only create a new one after user input resolves it.

let inputPromise = waitForInput();

while (true) {
  // Create a fresh heartbeat timer for each race
  const heartbeatPromise = new Promise<"heartbeat">((resolve) =>
    setTimeout(() => resolve("heartbeat"), HEARTBEAT_INTERVAL_MS),
  );

  const result = await Promise.race([
    inputPromise.then((input) => ({ kind: "input" as const, input })),
    heartbeatPromise.then(() => ({ kind: "heartbeat" as const })),
  ]);

  if (result.kind === "heartbeat") {
    const hb = await checkHeartbeat();
    if (!hb) continue; // nothing new, race again

    const notification = formatHeartbeatNotification(hb);
    await session.run(notification, callbacks);
    continue;
  }

  // User input — process and create a new input promise
  const input = result.input;
  inputPromise = waitForInput();

  if (!input) continue;
  await session.run(input, callbacks);
}
