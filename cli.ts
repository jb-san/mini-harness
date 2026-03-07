import { MessageBus } from "./src/mq/bus.ts";
import { createHarness } from "./src/harness/harness.ts";
import { createToolExecutor } from "./src/agent/tool-executor.ts";
import { Agent } from "./src/agent/agent.ts";
import { systemPrompt } from "./src/prompts/system.ts";
import { skillsExtension } from "./src/extensions/skills/index.ts";

const prompt = process.argv.slice(2).join(" ");
if (!prompt) {
  console.error("Usage: bun cli.ts <prompt>");
  process.exit(1);
}

const bus = new MessageBus();

const harness = await createHarness({
  bus,
  extensions: [skillsExtension],
  systemPrompt,
});

createToolExecutor(bus, harness.registry, harness.hooks);

// Console output via bus subscribers
bus.on("llm:chunk:reasoning", ({ text }) => {
  process.stdout.write(`[REASONING] ${JSON.stringify(text)}\n`);
});

bus.on("llm:chunk:content", ({ text }) => {
  process.stdout.write(`[CONTENT]   ${JSON.stringify(text)}\n`);
});

bus.on("tool:call", ({ name, args }) => {
  process.stderr.write(`[TOOL-START] ${name} ${JSON.stringify(args)}\n`);
});

bus.on("tool:result", ({ name, result }) => {
  const truncated = result.length > 300 ? result.slice(0, 300) + "..." : result;
  process.stderr.write(`[TOOL-OK]    ${name} ${truncated}\n`);
});

bus.on("tool:error", ({ name, error }) => {
  process.stderr.write(`[TOOL-ERR]   ${name} ${error}\n`);
});

bus.on("llm:done", ({ agentId }) => {
  if (agentId !== "main") return;
  setTimeout(() => {
    process.stderr.write(`\n--- done ---\n`);
    process.exit(0);
  }, 100);
});

bus.on("llm:error", ({ error }) => {
  process.stderr.write(`[ERROR] ${error}\n`);
  process.exit(1);
});

const agent = new Agent("main", bus, harness.runtime, harness.provider, harness.registry, systemPrompt);

bus.emit("user:input", { agentId: "main", text: prompt });
