export interface ToolContext {
  cwd: string;
  agentId: string;
  isSubAgent: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}
