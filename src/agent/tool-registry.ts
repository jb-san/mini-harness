import type { Tool, ToolContext, ToolDefinition } from "./tool.ts";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
    return tool.execute(args, ctx);
  }
}
