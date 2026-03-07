import { test, expect } from "bun:test";
import { MessageBus } from "../mq/bus.ts";
import { createHarness } from "./harness.ts";
import type { Extension } from "./types.ts";

test("createHarness registers 6 core tools", async () => {
  const bus = new MessageBus();
  const harness = await createHarness({ bus });

  const names = harness.registry.definitions.map((d) => d.name).sort();
  expect(names).toEqual([
    "list_dir",
    "read_file",
    "run_shell",
    "web_scrape",
    "web_search",
    "write_file",
  ]);

  await harness.destroy();
});

test("createHarness activates extensions with correct API", async () => {
  const bus = new MessageBus();
  let receivedAPI: any = null;

  const testExtension: Extension = {
    name: "test-ext",
    activate(api) {
      receivedAPI = api;
    },
  };

  const harness = await createHarness({ bus, extensions: [testExtension] });

  expect(receivedAPI).not.toBeNull();
  expect(receivedAPI.bus).toBe(bus);
  expect(typeof receivedAPI.getProvider).toBe("function");
  expect(typeof receivedAPI.getRegistry).toBe("function");
  expect(receivedAPI.getAgentId()).toBe("main");
  expect(receivedAPI.isSubAgent()).toBe(false);

  await harness.destroy();
});

test("createHarness with no extensions works", async () => {
  const bus = new MessageBus();
  const harness = await createHarness({ bus });

  expect(harness.registry.definitions.length).toBe(6);
  await harness.destroy();
});

test("extension can register tools via API", async () => {
  const bus = new MessageBus();

  const testExtension: Extension = {
    name: "tool-adder",
    activate(api) {
      api.registerTool({
        definition: { name: "custom_tool", description: "A custom tool" },
        async execute() { return "ok"; },
      });
    },
  };

  const harness = await createHarness({ bus, extensions: [testExtension] });

  expect(harness.registry.has("custom_tool")).toBe(true);
  expect(harness.registry.definitions.length).toBe(7);

  await harness.destroy();
});

test("extension deactivate is called on destroy", async () => {
  const bus = new MessageBus();
  let deactivated = false;

  const testExtension: Extension = {
    name: "deactivatable",
    activate() {},
    deactivate() { deactivated = true; },
  };

  const harness = await createHarness({ bus, extensions: [testExtension] });
  expect(deactivated).toBe(false);

  await harness.destroy();
  expect(deactivated).toBe(true);
});
