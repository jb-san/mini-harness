import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageBus } from "../../mq/bus.ts";
import { ToolRegistry } from "../../agent/tool-registry.ts";
import { ActorRuntime } from "../../runtime/actor-runtime.ts";
import { discoverSkillsFromRoots, skillsExtension } from "./index.ts";

let tempRoot = "";
let originalHome = "";

async function createSkill(root: string, dirName: string, frontmatter: string, body = "") {
  const skillDir = join(root, dirName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `${frontmatter}\n${body}`);
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "mini-harness-skills-"));
  originalHome = process.env.HOME ?? "";
  process.env.HOME = join(tempRoot, "home");
  await mkdir(process.env.HOME, { recursive: true });
});

afterEach(async () => {
  process.env.HOME = originalHome;
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("skills extension registers discover_skills", async () => {
  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const registry = new ToolRegistry();
  const tools: string[] = [];

  await skillsExtension.activate({
    registerTool: (tool) => tools.push(tool.definition.name),
    unregisterTool: () => {},
    bus,
    getProvider: () => ({} as any),
    getRegistry: () => registry,
    getRuntime: () => runtime,
    getAgentId: () => "main",
    getCwd: () => tempRoot,
    isSubAgent: () => false,
  });

  expect(tools).toEqual(["discover_skills"]);
});

test("discoverSkillsFromRoots prefers project skills over user duplicates", async () => {
  const projectSkills = join(tempRoot, ".mini-harness/skills");
  const userSkills = join(process.env.HOME!, ".agents/skills");

  await createSkill(
    projectSkills,
    "research",
    [
      "---",
      "name: research",
      "description: Project-local research workflow",
      "---",
    ].join("\n"),
  );

  await createSkill(
    userSkills,
    "research",
    [
      "---",
      "name: research",
      "description: User-level duplicate that should be shadowed",
      "---",
    ].join("\n"),
  );

  await createSkill(
    userSkills,
    "debugger",
    [
      "---",
      "name: debugger",
      "description: Debugging workflow",
      "---",
    ].join("\n"),
  );

  const result = await discoverSkillsFromRoots(tempRoot);

  expect(result.skills.map((skill) => skill.name)).toEqual(["debugger", "research"]);
  expect(result.skills.find((skill) => skill.name === "research")?.description).toBe(
    "Project-local research workflow",
  );
  expect(result.diagnostics.some((entry) => entry.includes("shadowed duplicate skill research"))).toBe(true);
});

test("discoverSkillsFromRoots filters by query and skips malformed skills", async () => {
  const projectSkills = join(tempRoot, ".agents/skills");

  await createSkill(
    projectSkills,
    "frontend-audit",
    [
      "---",
      "name: frontend-audit",
      "description: Inspect UI state and rendering behavior",
      "---",
    ].join("\n"),
  );

  await createSkill(
    projectSkills,
    "broken",
    [
      "---",
      "name: broken",
      "---",
    ].join("\n"),
  );

  const result = await discoverSkillsFromRoots(tempRoot, "ui", 5);

  expect(result.skills.length).toBe(1);
  expect(result.skills[0].name).toBe("frontend-audit");
  expect(result.diagnostics.some((entry) => entry.includes("missing required description field"))).toBe(true);
});

test("discover_skills tool returns discovered metadata and locations", async () => {
  const projectSkills = join(tempRoot, ".mini-harness/skills");
  await createSkill(
    projectSkills,
    "ops",
    [
      "---",
      "name: ops",
      "description: Operate the harness",
      "---",
    ].join("\n"),
  );

  const bus = new MessageBus();
  const runtime = new ActorRuntime(bus);
  const registry = new ToolRegistry();
  const tools = new Map<string, any>();

  await skillsExtension.activate({
    registerTool: (tool) => tools.set(tool.definition.name, tool),
    unregisterTool: () => {},
    bus,
    getProvider: () => ({} as any),
    getRegistry: () => registry,
    getRuntime: () => runtime,
    getAgentId: () => "main",
    getCwd: () => tempRoot,
    isSubAgent: () => false,
  });

  const result = await tools.get("discover_skills").execute(
    { query: "operate" },
    { cwd: tempRoot, agentId: "main", isSubAgent: false },
  );

  const parsed = JSON.parse(result);
  expect(parsed.skills.length).toBe(1);
  expect(parsed.skills[0].name).toBe("ops");
  expect(parsed.skills[0].location).toContain("/ops/SKILL.md");
});
