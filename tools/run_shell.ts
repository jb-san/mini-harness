import type { Tool } from "./index";

export const run_shell: Tool = {
  definition: {
    type: "function",
    name: "run_shell",
    description: "Execute a shell command and return stdout/stderr",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute",
        },
      },
      required: ["command"],
    },
  },
  async execute(args) {
    const proc = Bun.spawn(["sh", "-c", args.command as string], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return JSON.stringify({ stdout, stderr, exitCode });
  },
};
