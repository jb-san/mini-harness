import { readdir, mkdir } from "fs/promises";
import type { Tool } from "./index";

const AGENTS_DIR = ".mini-harness/agents";

export interface AgentMeta {
  id: string;
  prompt: string;
  context?: string;
  status: "running" | "completed" | "error";
  pid?: number;
  started_at: string;
  finished_at?: string;
}

// In-memory registry of spawned subprocesses
const subprocesses = new Map<string, ReturnType<typeof Bun.spawn>>();

async function ensureAgentsDir() {
  await mkdir(AGENTS_DIR, { recursive: true });
}

async function nextAgentId(): Promise<string> {
  await ensureAgentsDir();
  let max = 0;
  try {
    const dirs = await readdir(AGENTS_DIR);
    for (const d of dirs) {
      const num = parseInt(d.replace(/^a/, ""), 10);
      if (!isNaN(num) && num > max) max = num;
    }
  } catch {
    // empty dir
  }
  return `a${String(max + 1).padStart(3, "0")}`;
}

export const spawn_agent: Tool = {
  definition: {
    type: "function",
    name: "spawn_agent",
    description:
      "Spawn an async sub-agent that runs in the background. It shares the filesystem and can communicate via the message queue. Returns immediately with the agent ID.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The task/prompt for the sub-agent",
        },
        context: {
          type: "string",
          description:
            "Optional extra context to prepend to the prompt (e.g. relevant file contents, prior findings)",
        },
      },
      required: ["prompt"],
    },
  },
  async execute(args) {
    const prompt = args.prompt as string;
    const context = args.context as string | undefined;
    const agentId = await nextAgentId();
    const agentDir = `${AGENTS_DIR}/${agentId}`;

    await mkdir(agentDir, { recursive: true });

    const meta: AgentMeta = {
      id: agentId,
      prompt,
      context,
      status: "running",
      started_at: new Date().toISOString(),
    };

    await Bun.write(`${agentDir}/meta.json`, JSON.stringify(meta, null, 2));

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      AGENT_ID: agentId,
    };
    if (context) {
      env.AGENT_CONTEXT = context;
    }

    const proc = Bun.spawn(["bun", "agent.ts", prompt], {
      env,
      cwd: process.cwd(),
      stdout: "ignore",
      stderr: "ignore",
    });

    meta.pid = proc.pid;
    await Bun.write(`${agentDir}/meta.json`, JSON.stringify(meta, null, 2));

    subprocesses.set(agentId, proc);

    // Monitor completion in background
    proc.exited.then(async (exitCode) => {
      try {
        const metaFile = Bun.file(`${agentDir}/meta.json`);
        const currentMeta: AgentMeta = await metaFile.json();
        if (currentMeta.status === "running") {
          currentMeta.status = exitCode === 0 ? "completed" : "error";
          currentMeta.finished_at = new Date().toISOString();
          await Bun.write(`${agentDir}/meta.json`, JSON.stringify(currentMeta, null, 2));
        }
      } catch {
        // best effort
      }
    });

    return JSON.stringify({
      agent_id: agentId,
      status: "spawned",
      prompt_preview: prompt.slice(0, 100),
    });
  },
};

export const check_agents: Tool = {
  definition: {
    type: "function",
    name: "check_agents",
    description:
      "Check the status of all spawned sub-agents. Returns a summary of each agent's current state.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  async execute() {
    await ensureAgentsDir();
    let dirs: string[];
    try {
      dirs = await readdir(AGENTS_DIR);
    } catch {
      return JSON.stringify([]);
    }

    const agents: {
      id: string;
      status: string;
      prompt_preview: string;
      started_at: string;
      finished_at?: string;
    }[] = [];

    for (const d of dirs.sort()) {
      try {
        const meta: AgentMeta = await Bun.file(
          `${AGENTS_DIR}/${d}/meta.json`,
        ).json();
        agents.push({
          id: meta.id,
          status: meta.status,
          prompt_preview: meta.prompt.slice(0, 100),
          started_at: meta.started_at,
          finished_at: meta.finished_at,
        });
      } catch {
        // skip malformed entries
      }
    }

    return JSON.stringify(agents);
  },
};

export const get_agent_result: Tool = {
  definition: {
    type: "function",
    name: "get_agent_result",
    description:
      "Get the full result and step-by-step output of a completed sub-agent.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: 'The agent ID, e.g. "a001"',
        },
      },
      required: ["agent_id"],
    },
  },
  async execute(args) {
    const agentId = args.agent_id as string;
    const agentDir = `${AGENTS_DIR}/${agentId}`;

    // Read meta
    let meta: AgentMeta;
    try {
      meta = await Bun.file(`${agentDir}/meta.json`).json();
    } catch {
      return JSON.stringify({ error: `Agent not found: ${agentId}` });
    }

    // Read result if available
    let result = null;
    try {
      result = await Bun.file(`${agentDir}/result.json`).json();
    } catch {
      // not yet completed
    }

    // Read output log
    let outputLog: unknown[] = [];
    try {
      const outputText = await Bun.file(`${agentDir}/output.jsonl`).text();
      outputLog = outputText
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      // no output yet
    }

    return JSON.stringify({
      meta,
      result,
      output_log: outputLog,
    });
  },
};
