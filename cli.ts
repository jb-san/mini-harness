import { createSession, type UICallbacks } from "./core";

const prompt = process.argv.slice(2).join(" ");
if (!prompt) {
  console.error("Usage: bun cli.ts <prompt>");
  process.exit(1);
}

const callbacks: UICallbacks = {
  onIterationStart(iteration) {
    process.stderr.write(`\n--- iteration ${iteration} ---\n`);
  },
  onReasoningChunk(chunk) {
    process.stdout.write(`[REASONING] ${JSON.stringify(chunk)}\n`);
  },
  onContentChunk(chunk) {
    process.stdout.write(`[CONTENT]   ${JSON.stringify(chunk)}\n`);
  },
  onToolStart(name, args) {
    process.stderr.write(`[TOOL-START] ${name} ${JSON.stringify(args)}\n`);
  },
  onToolResult(name, result) {
    const truncated = result.length > 300 ? result.slice(0, 300) + "..." : result;
    process.stderr.write(`[TOOL-OK]    ${name} ${truncated}\n`);
  },
  onToolError(name, error) {
    process.stderr.write(`[TOOL-ERR]   ${name} ${error}\n`);
  },
  onAssistantDone(text) {
    process.stderr.write(`\n--- done ---\n`);
  },
  onError(error) {
    process.stderr.write(`[ERROR] ${error}\n`);
  },
  onContextUpdate() {},
};

const session = createSession();
await session.run(prompt, callbacks);
