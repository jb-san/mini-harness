import type { Tool } from "../tool.ts";

export const writeFile: Tool = {
  definition: {
    name: "write_file",
    description: "Write content to a file, creating it if it doesn't exist",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
    },
  },
  async execute(args, _ctx) {
    await Bun.write(args.path as string, args.content as string);
    return JSON.stringify({ success: true, path: args.path });
  },
};
