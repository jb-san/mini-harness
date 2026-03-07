import type { Tool } from "../tool.ts";

export const readFile: Tool = {
  definition: {
    name: "read_file",
    description: "Read the contents of a file at the given path",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path",
        },
      },
      required: ["path"],
    },
  },
  async execute(args, _ctx) {
    const file = Bun.file(args.path as string);
    if (!(await file.exists())) {
      return JSON.stringify({ error: `File not found: ${args.path}` });
    }
    return await file.text();
  },
};
