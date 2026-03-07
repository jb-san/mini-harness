import { MessageBus } from "./src/mq/bus.ts";
import { createHarness } from "./src/harness/harness.ts";
import { createToolExecutor } from "./src/agent/tool-executor.ts";
import { Agent } from "./src/agent/agent.ts";
import { createUI } from "./src/ui/index.tsx";
import { systemPrompt } from "./src/prompts/system.ts";
import { skillsExtension } from "./src/extensions/skills/index.ts";

const bus = new MessageBus();

const harness = await createHarness({
  bus,
  extensions: [skillsExtension],
  systemPrompt,
});

createToolExecutor(bus, harness.registry, harness.hooks);

const agent = new Agent("main", bus, harness.runtime, harness.provider, harness.registry, systemPrompt);

const ui = await createUI(bus);
