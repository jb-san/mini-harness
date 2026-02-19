import { readdir } from "fs/promises";
import type { Tool } from "./index";

export const list_dir: Tool = {
  definition: {
    type: "function",
    name: "list_dir",
    description: "List files and directories at the given path",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path to list (defaults to current directory)",
        },
      },
    },
  },
  async execute(args) {
    const dir = (args.path as string) || ".";
    const entries = await readdir(dir, { withFileTypes: true });
    const items = entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "directory" : "file",
    }));
    return JSON.stringify(items);
  },
};
