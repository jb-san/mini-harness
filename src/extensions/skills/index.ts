import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Extension } from "../../harness/types.ts";
import type { Tool } from "../../agent/tool.ts";

export interface SkillRecord {
  name: string;
  description: string;
  location: string;
  scope: "project" | "user";
  warnings: string[];
}

interface FrontmatterResult {
  fields: Record<string, string>;
  warnings: string[];
}

const SKILL_FILE = "SKILL.md";
const MAX_SCAN_DEPTH = 4;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build"]);

function userHome(): string {
  return process.env.HOME || homedir();
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function validateSkillName(name: string): string[] {
  const warnings: string[] = [];
  if (name.length > 64) warnings.push("name exceeds 64 characters");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    warnings.push("name should contain lowercase letters, numbers, and single hyphens only");
  }
  return warnings;
}

function extractFrontmatter(content: string): FrontmatterResult | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return null;

  const raw = content.slice(4, end).replace(/\r/g, "");
  const fields: Record<string, string> = {};
  const warnings: string[] = [];
  const lines = raw.split("\n");

  let blockKey: string | null = null;
  let blockIndent = 0;

  for (const line of lines) {
    if (!line.trim()) {
      if (blockKey) {
        fields[blockKey] = `${fields[blockKey]}\n`;
      }
      continue;
    }

    if (blockKey) {
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent > blockIndent) {
        const current = fields[blockKey] ?? "";
        fields[blockKey] = current
          ? `${current}\n${line.slice(blockIndent + 1)}`
          : line.slice(blockIndent + 1);
        continue;
      }
      blockKey = null;
      blockIndent = 0;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      warnings.push(`could not parse frontmatter line: ${line.trim()}`);
      continue;
    }

    const [, rawKey, rawValue] = match;
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();

    if (value === "|" || value === ">") {
      blockKey = key;
      blockIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
      fields[key] = "";
      continue;
    }

    fields[key] = unquote(value);
  }

  return { fields, warnings };
}

async function discoverSkillFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH) return [];

  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const skillFiles: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name === SKILL_FILE) {
      skillFiles.push(join(root, entry.name));
      continue;
    }

    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    skillFiles.push(...await discoverSkillFiles(join(root, entry.name), depth + 1));
  }

  return skillFiles;
}

async function loadSkillRecord(
  location: string,
  scope: "project" | "user",
): Promise<{ skill?: SkillRecord; diagnostics: string[] }> {
  const diagnostics: string[] = [];

  let content: string;
  try {
    content = await readFile(location, "utf8");
  } catch (error) {
    return { diagnostics: [`failed to read ${location}: ${String(error)}`] };
  }

  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) {
    return { diagnostics: [`skipping ${location}: missing valid YAML frontmatter`] };
  }

  const name = frontmatter.fields.name?.trim();
  const description = frontmatter.fields.description?.trim();

  if (!name) {
    return { diagnostics: [`skipping ${location}: missing required name field`] };
  }

  if (!description) {
    return { diagnostics: [`skipping ${location}: missing required description field`] };
  }

  const warnings = [...frontmatter.warnings, ...validateSkillName(name)];
  const parentDir = basename(dirname(location));
  if (parentDir !== name) {
    warnings.push(`name does not match parent directory (${parentDir})`);
  }

  return {
    skill: {
      name,
      description,
      location,
      scope,
      warnings,
    },
    diagnostics,
  };
}

export async function discoverSkillsFromRoots(
  projectRoot: string,
  query?: string,
  limit?: number,
): Promise<{ skills: SkillRecord[]; diagnostics: string[]; roots: string[] }> {
  const roots = [
    { path: resolve(projectRoot, ".mini-harness/skills"), scope: "project" as const },
    { path: resolve(projectRoot, ".agents/skills"), scope: "project" as const },
    { path: resolve(userHome(), ".mini-harness/skills"), scope: "user" as const },
    { path: resolve(userHome(), ".agents/skills"), scope: "user" as const },
  ];

  const seen = new Map<string, SkillRecord>();
  const diagnostics: string[] = [];

  for (const root of roots) {
    const files = await discoverSkillFiles(root.path);
    for (const file of files) {
      const { skill, diagnostics: fileDiagnostics } = await loadSkillRecord(file, root.scope);
      diagnostics.push(...fileDiagnostics);
      if (!skill) continue;
      if (seen.has(skill.name)) {
        diagnostics.push(`shadowed duplicate skill ${skill.name} at ${skill.location}`);
        continue;
      }
      seen.set(skill.name, skill);
    }
  }

  let skills = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));

  if (query) {
    const needle = query.toLowerCase();
    skills = skills.filter((skill) =>
      skill.name.toLowerCase().includes(needle) ||
      skill.description.toLowerCase().includes(needle),
    );
  }

  const max = typeof limit === "number" && Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : undefined;
  if (max) {
    skills = skills.slice(0, max);
  }

  return {
    skills,
    diagnostics,
    roots: roots.map((root) => root.path),
  };
}

export const skillsExtension: Extension = {
  name: "skills",
  activate(api) {
    const projectRoot = api.getCwd();

    const discoverSkills: Tool = {
      definition: {
        name: "discover_skills",
        description:
          "Discover available Agent Skills by scanning standard project and user skill directories. Returns metadata only; read the selected SKILL.md file with read_file if you decide to use a skill.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Optional search term to filter skills by name or description",
            },
            limit: {
              type: "number",
              description:
                "Optional maximum number of matching skills to return",
            },
          },
        },
      },
      async execute(args) {
        const query = typeof args.query === "string" ? args.query : undefined;
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        return JSON.stringify(await discoverSkillsFromRoots(projectRoot, query, limit));
      },
    };

    api.registerTool(discoverSkills);
  },
};
