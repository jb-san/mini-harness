import { readdir, mkdir, rename } from "fs/promises";
import type { Tool } from "./index";

const TASKS_DIR = ".mini-harness/tasks";
const STATUSES = ["todo", "doing", "done"] as const;
type Status = (typeof STATUSES)[number];

async function ensureDirs() {
  for (const s of STATUSES) {
    await mkdir(`${TASKS_DIR}/${s}`, { recursive: true });
  }
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function nextId(): Promise<string> {
  await ensureDirs();
  let max = 0;
  for (const s of STATUSES) {
    const files = await readdir(`${TASKS_DIR}/${s}`);
    for (const f of files) {
      const num = parseInt(f.slice(0, 3), 10);
      if (!isNaN(num) && num > max) max = num;
    }
  }
  return String(max + 1).padStart(3, "0");
}

async function findTask(
  id: string
): Promise<{ status: Status; filename: string; path: string } | null> {
  await ensureDirs();
  for (const s of STATUSES) {
    const files = await readdir(`${TASKS_DIR}/${s}`);
    const match = files.find((f) => f.startsWith(id));
    if (match) {
      return {
        status: s,
        filename: match,
        path: `${TASKS_DIR}/${s}/${match}`,
      };
    }
  }
  return null;
}

export const create_task: Tool = {
  definition: {
    type: "function",
    name: "create_task",
    description:
      "Create a new task in the todo folder with a title, description, and acceptance criteria",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Task description" },
        criteria: {
          type: "array",
          items: { type: "string" },
          description: "List of acceptance criteria",
        },
      },
      required: ["title", "description", "criteria"],
    },
  },
  async execute(args) {
    const title = args.title as string;
    const description = args.description as string;
    const criteria = args.criteria as string[];

    const id = await nextId();
    const filename = `${id}-${slugify(title)}.md`;
    const path = `${TASKS_DIR}/todo/${filename}`;

    const content = [
      `# ${title}`,
      "",
      "## Description",
      description,
      "",
      "## Acceptance Criteria",
      ...criteria.map((c) => `- [ ] ${c}`),
      "",
    ].join("\n");

    await Bun.write(path, content);
    return JSON.stringify({ id, filename, path });
  },
};

export const list_tasks: Tool = {
  definition: {
    type: "function",
    name: "list_tasks",
    description:
      'List tasks, optionally filtered by status ("todo", "doing", "done")',
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["todo", "doing", "done"],
          description: "Filter by status (omit for all)",
        },
      },
    },
  },
  async execute(args) {
    await ensureDirs();
    const folders =
      args.status && STATUSES.includes(args.status as Status)
        ? [args.status as Status]
        : [...STATUSES];

    const tasks: { id: string; title: string; status: string; filename: string }[] = [];
    for (const s of folders) {
      const files = await readdir(`${TASKS_DIR}/${s}`);
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const id = f.slice(0, 3);
        const title = f
          .slice(4)
          .replace(/\.md$/, "")
          .replace(/-/g, " ");
        tasks.push({ id, title, status: s, filename: f });
      }
    }
    return JSON.stringify(tasks);
  },
};

export const read_task: Tool = {
  definition: {
    type: "function",
    name: "read_task",
    description: "Read a task's full contents and current status by its ID",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: 'Task ID, e.g. "001"',
        },
      },
      required: ["id"],
    },
  },
  async execute(args) {
    const found = await findTask(args.id as string);
    if (!found) {
      return JSON.stringify({ error: `Task not found: ${args.id}` });
    }
    const content = await Bun.file(found.path).text();
    return JSON.stringify({ id: args.id, status: found.status, content });
  },
};

export const update_task: Tool = {
  definition: {
    type: "function",
    name: "update_task",
    description:
      "Overwrite a task's markdown content (e.g. to check off acceptance criteria)",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: 'Task ID, e.g. "001"' },
        content: {
          type: "string",
          description: "Full new markdown content for the task",
        },
      },
      required: ["id", "content"],
    },
  },
  async execute(args) {
    const found = await findTask(args.id as string);
    if (!found) {
      return JSON.stringify({ error: `Task not found: ${args.id}` });
    }
    await Bun.write(found.path, args.content as string);
    return JSON.stringify({ success: true, id: args.id, path: found.path });
  },
};

export const move_task: Tool = {
  definition: {
    type: "function",
    name: "move_task",
    description:
      'Move a task between statuses (todo, doing, done). Moving to "done" requires all acceptance criteria to be checked off.',
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: 'Task ID, e.g. "001"' },
        to: {
          type: "string",
          enum: ["todo", "doing", "done"],
          description: "Target status",
        },
      },
      required: ["id", "to"],
    },
  },
  async execute(args) {
    const id = args.id as string;
    const to = args.to as Status;

    const found = await findTask(id);
    if (!found) {
      return JSON.stringify({ error: `Task not found: ${id}` });
    }

    if (found.status === to) {
      return JSON.stringify({ error: `Task is already in ${to}` });
    }

    const content = await Bun.file(found.path).text();

    // Gate: moving to done requires all criteria checked
    if (to === "done") {
      const unchecked = content
        .split("\n")
        .filter((line) => /^- \[ \]/.test(line))
        .map((line) => line.replace(/^- \[ \] /, ""));

      if (unchecked.length > 0) {
        return JSON.stringify({
          error: "Cannot move to done — unchecked criteria remain",
          unchecked,
        });
      }
    }

    // Append completion timestamp when moving to done
    let finalContent = content;
    if (to === "done") {
      finalContent =
        content.trimEnd() +
        `\n\n## Completed\n${new Date().toISOString()}\n`;
    }

    const newPath = `${TASKS_DIR}/${to}/${found.filename}`;
    await Bun.write(newPath, finalContent);

    // Remove original if it's in a different folder
    const { unlink } = await import("fs/promises");
    await unlink(found.path);

    return JSON.stringify({
      id,
      from: found.status,
      to,
      filename: found.filename,
    });
  },
};
