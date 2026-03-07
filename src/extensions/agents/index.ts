import type { Extension } from "../../harness/types.ts";
import type { Tool } from "../../agent/tool.ts";
import { Agent } from "../../agent/agent.ts";
import { subAgentPrompt } from "../../prompts/sub_agent.ts";

export interface AgentMeta {
  id: string;
  prompt: string;
  context?: string;
  status: "running" | "completed" | "error";
  started_at: string;
  finished_at?: string;
  result?: string;
  error?: string;
}

export const agentsExtension: Extension = {
  name: "agents",
  activate(api) {
    if (api.isSubAgent()) return;

    const bus = api.bus;
    const runtime = api.getRuntime();
    const provider = api.getProvider();
    const registry = api.getRegistry();
    const parentId = api.getAgentId();
    const agents = new Map<string, AgentMeta>();
    let agentCounter = 0;

    const nextAgentId = (): string => {
      agentCounter++;
      return `a${String(agentCounter).padStart(3, "0")}`;
    };

    bus.on("agent:completed", ({ agentId, result }) => {
      const meta = agents.get(agentId);
      if (!meta) return;
      meta.status = "completed";
      meta.finished_at = new Date().toISOString();
      meta.result = result;
    });

    bus.on("agent:error", ({ agentId, error }) => {
      const meta = agents.get(agentId);
      if (!meta) return;
      meta.status = "error";
      meta.finished_at = new Date().toISOString();
      meta.error = error;
    });

    const spawnAgent: Tool = {
      definition: {
        name: "spawn_agent",
        description:
          "Spawn an async sub-agent that runs in-process. It shares the filesystem, has its own mailbox, and can communicate via actor messages. Returns immediately with the agent ID.",
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
        const agentId = nextAgentId();

        const meta: AgentMeta = {
          id: agentId,
          prompt,
          context,
          status: "running",
          started_at: new Date().toISOString(),
        };
        agents.set(agentId, meta);

        bus.emit("agent:spawned", {
          agentId,
          parentId,
          prompt,
        });

        runtime.setParent(agentId, parentId);

        const systemPrompt = subAgentPrompt(agentId);
        const subAgent = new Agent(agentId, bus, runtime, provider, registry, systemPrompt);

        const fullPrompt = context
          ? `[Context from parent agent]\n${context}\n\n[Task]\n${prompt}`
          : prompt;

        const unsubDone = bus.on("llm:done", (p) => {
          if (p.agentId !== agentId) return;
          unsubDone();
          unsubError();
          const result = p.text || subAgent.lastResponse;
          runtime.completeAgent(agentId, result);
        });

        const unsubError = bus.on("llm:error", (p) => {
          if (p.agentId !== agentId) return;
          unsubDone();
          unsubError();
          runtime.failAgent(agentId, p.error);
        });

        subAgent.send(fullPrompt);

        return JSON.stringify({
          agent_id: agentId,
          status: "spawned",
          prompt_preview: prompt.slice(0, 100),
        });
      },
    };

    const checkAgents: Tool = {
      definition: {
        name: "check_agents",
        description:
          "Check the status of all spawned sub-agents. Returns a summary of each agent's current state.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
      async execute() {
        const result = [...agents.values()].map((meta) => ({
          id: meta.id,
          status: meta.status,
          prompt_preview: meta.prompt.slice(0, 100),
          started_at: meta.started_at,
          finished_at: meta.finished_at,
        }));
        return JSON.stringify(result);
      },
    };

    const getAgentResult: Tool = {
      definition: {
        name: "get_agent_result",
        description: "Get the result of a completed sub-agent.",
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
        const meta = agents.get(agentId);
        if (!meta) {
          return JSON.stringify({ error: `Agent not found: ${agentId}` });
        }
        return JSON.stringify({
          meta: {
            id: meta.id,
            status: meta.status,
            prompt: meta.prompt,
            started_at: meta.started_at,
            finished_at: meta.finished_at,
          },
          result: meta.result ?? null,
          error: meta.error ?? null,
        });
      },
    };

    api.registerTool(spawnAgent);
    api.registerTool(checkAgents);
    api.registerTool(getAgentResult);
  },
};
