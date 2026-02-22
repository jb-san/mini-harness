export interface Tool {
  definition: {
    type: "function";
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  };
  execute(args: Record<string, unknown>): Promise<string>;
}

import { read_file } from "./read_file";
import { write_file } from "./write_file";
import { list_dir } from "./list_dir";
import { run_shell } from "./run_shell";
import {
  create_task,
  list_tasks,
  read_task,
  update_task,
  move_task,
} from "./tasks";
import { mq_send, mq_read, setMqAgentId } from "./mq";
import {
  spawn_agent,
  check_agents,
  get_agent_result,
} from "./agents";

// Tools available to all agents
const sharedTools: Tool[] = [
  read_file,
  write_file,
  list_dir,
  run_shell,
  create_task,
  list_tasks,
  read_task,
  update_task,
  move_task,
  mq_send,
  mq_read,
];

// Tools only available to the main agent
const mainOnlyTools: Tool[] = [spawn_agent, check_agents, get_agent_result];

const allTools: Tool[] = [...sharedTools, ...mainOnlyTools];

export function getToolsForAgent(
  agentId: string,
  isSubAgent: boolean,
): { definitions: Tool["definition"][]; execute: (name: string, args: Record<string, unknown>) => Promise<string> } {
  setMqAgentId(agentId);

  const tools = isSubAgent ? sharedTools : allTools;
  const toolMap = new Map(tools.map((t) => [t.definition.name, t]));

  return {
    definitions: tools.map((t) => t.definition),
    execute: async (name, args) => {
      const tool = toolMap.get(name);
      if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
      return tool.execute(args);
    },
  };
}

// Legacy exports for backwards compatibility with existing code
export const toolDefinitions = allTools.map((t) => t.definition);

const toolMap = new Map(allTools.map((t) => [t.definition.name, t]));

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = toolMap.get(name);
  if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
  return tool.execute(args);
}
