import type { Tool } from "./index";

export const read_file: Tool = {
  definition: {
    type: "function",
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
  async execute(args) {
    const file = Bun.file(args.path as string);
    if (!(await file.exists())) {
      return JSON.stringify({ error: `File not found: ${args.path}` });
    }
    return await file.text();
  },
};
