# Mini-Harness

A local coding-agent harness with a deliberately small built-in kernel:

- `read_file`
- `write_file`
- `list_dir`
- `run_shell`
- `web_search`
- `web_scrape`
- `discover_skills`

Everything else is meant to be layered on top through discovered skills, scripts inside skills, and repo-local hooks.

## Model

The harness is intentionally biased toward:

- a tiny native tool surface
- discoverable skills instead of prompt bloat
- user-owned extensions in the workspace
- debug visibility through the terminal UI

The default system behavior is:

1. Use the low-level kernel first.
2. Discover skills only when a task needs a specialized workflow.
3. Treat “add a tool” requests as “create a skill” requests by default.
4. Use scripts inside skills rather than promoting everything into native tools.

## Core Tools

The built-in native tools are:

- `read_file(path)`
- `write_file(path, content)`
- `list_dir(path)`
- `run_shell(command)`
- `web_search(query, limit?)`
- `web_scrape(url, selector?, extract?, include_links?, max_chars?)`
- `discover_skills(query?, limit?)`

`discover_skills` scans standard skill roots and returns metadata plus the absolute `SKILL.md` location to read on demand.

## Local Web Access

Web search and scraping are built in, but they are still local-first:

- no hosted search API is used
- no hosted scraping API is used
- the harness shells out to a local Python bridge backed by `Scrapling`

Install the local dependency:

```bash
python3 -m pip install "scrapling[fetchers]"
```

The bundled bridge lives at [scripts/scrapling_bridge.py](/Users/jb/Developer/Personal/mini-harness/scripts/scrapling_bridge.py).

### `web_search`

`web_search` currently scrapes DuckDuckGo HTML search results locally and returns structured results:

```json
{
  "engine": "duckduckgo",
  "query": "scrapling github",
  "results": [
    {
      "title": "GitHub - D4Vinci/Scrapling: ...",
      "url": "https://github.com/D4Vinci/Scrapling",
      "snippet": "..."
    }
  ]
}
```

### `web_scrape`

`web_scrape` fetches a page and extracts either text or HTML. It also supports optional CSS selectors and link extraction.

Example:

```text
Scrape https://example.com and return the main content.
```

Or with a selector:

```text
Scrape https://example.com using selector "main article" and include links.
```

## Skills

Skills are the main extension surface.

Typical flow:

1. Call `discover_skills("skill-creator")`
2. Read the chosen `SKILL.md` with `read_file`
3. Follow the skill instructions
4. If automation is needed, add scripts inside the skill and invoke them through `run_shell`

Project skill roots currently scanned:

- `.mini-harness/skills`
- `.agents/skills`

User skill roots currently scanned:

- `~/.mini-harness/skills`
- `~/.agents/skills`

Project skills take precedence over user skills when names collide.

## Hooks

Hooks let the repository or user inject callbacks into key harness events without modifying the core runtime.

Hook files live under:

- `.mini-harness/hooks/index.ts`
- `.mini-harness/hooks/context.ts`
- `.mini-harness/hooks/tools.ts`

You can export any of these callbacks:

- `onContextUpdate(event)`
- `onContextIncrease(currentContextSize, event)`
- `beforeToolCall(event)`
- `afterToolCall(event)`
- `onToolError(event)`

Hooks are loaded once at startup. They are isolated from the harness:

- hook errors are caught
- hook calls time out
- hook failures do not crash the harness
- blocked tool calls are surfaced as normal tool errors

### Context Hooks

`onContextUpdate(event)` receives:

```ts
type ContextHookEvent = {
  agentId: string;
  model: string;
  tokensUsed: number;
  maxTokens: number;
  utilization: number; // 0..1
  utilizationPercent: number; // 0..100
  previousUtilization: number | null;
  previousUtilizationPercent: number | null;
};
```

`onContextIncrease(currentContextSize, event)` is called only when utilization increases. `currentContextSize` is the current utilization percentage from `0` to `100`.

Example:

```ts
// .mini-harness/hooks/context.ts
export async function onContextIncrease(currentContextSize, event) {
  if (currentContextSize >= 70) {
    await Bun.$`curl -X POST http://localhost:4000/restart`;
  }
}
```

### Tool Hooks

`beforeToolCall(event)` receives:

```ts
type ToolHookBaseEvent = {
  agentId: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  cwd: string;
  isSubAgent: boolean;
};
```

If it returns `{ allow: false, reason: "..." }`, the tool call is blocked.

`afterToolCall(event)` receives the same fields plus `result: string`.

`onToolError(event)` receives the same fields plus `error: string`.

Example gate:

```ts
// .mini-harness/hooks/tools.ts
export async function beforeToolCall(event) {
  if (event.name !== "run_shell") return;

  const payload = JSON.stringify(event.args);
  if (payload.includes("rm -rf")) {
    return { allow: false, reason: "dangerous shell command blocked by hook" };
  }
}
```

Example audit hook:

```ts
// .mini-harness/hooks/tools.ts
export async function afterToolCall(event) {
  await Bun.write(
    ".mini-harness/tool-audit.log",
    `[${new Date().toISOString()}] ${event.agentId} ${event.name}\n`,
    { createPath: true },
  );
}
```

## Running

Install dependencies:

```bash
bun install
```

Start the TUI:

```bash
bun start
```

Run a one-shot prompt:

```bash
bun cli.ts "inspect the repo and summarize the architecture"
```

## Terminal UI

The UI is laid out as a command center:

- left: coordinator and agent summaries
- center: reasoning stream, conversation, command input
- right: orchestration timeline and tool traffic

Hook events are also shown in the telemetry timeline, which makes hook blocks and failures visible while debugging.

## Examples

Ask the harness to use the low-level kernel:

```text
Read package.json and summarize the scripts.
```

Ask the harness to extend itself through skills:

```text
Create a new capability for reviewing CI failures. Use the skill-creator flow.
```

Ask the harness to inspect available skills first:

```text
Discover skills related to Figma and explain which one should be used.
```

## Testing

Run the full test suite:

```bash
bun test
```

## Notes

- The harness keeps the native core small on purpose.
- Skills are the preferred mechanism for adding reusable capabilities.
- Scripts inside skills are preferred over native tool promotion.
- Hooks are for repository-specific policy, automation, and observability at runtime.
