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

const allTools: Tool[] = [read_file, write_file, list_dir, run_shell];

export const toolDefinitions = allTools.map((t) => t.definition);

const toolMap = new Map(allTools.map((t) => [t.definition.name, t]));

export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = toolMap.get(name);
  if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
  return tool.execute(args);
}
