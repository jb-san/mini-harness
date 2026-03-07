import { resolve } from "node:path";
import type { Tool } from "../tool.ts";

type BridgePayload = Record<string, unknown>;
type BridgeRunner = (payload: BridgePayload) => Promise<string>;

const BRIDGE_PATH = resolve(process.cwd(), "scripts/scrapling_bridge.py");

async function defaultRunner(payload: BridgePayload): Promise<string> {
  const proc = Bun.spawn(["python3", BRIDGE_PATH], {
    stdin: new Blob([JSON.stringify(payload)]).stream(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0 && !stdout.trim()) {
    return JSON.stringify({
      error:
        stderr.trim() ||
        `scrapling bridge exited with code ${exitCode}. Install Scrapling with ` +
          '`python3 -m pip install "scrapling[fetchers]"`.',
    });
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    return JSON.stringify({
      error:
        stderr.trim() ||
        "scrapling bridge returned no output",
    });
  }

  return trimmed;
}

function normalizeLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function normalizeMaxChars(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(250, Math.floor(value))
    : fallback;
}

export function createWebTools(runner: BridgeRunner = defaultRunner) {
  const webSearch: Tool = {
    definition: {
      name: "web_search",
      description:
        "Search the web locally by scraping DuckDuckGo HTML results through Scrapling. No external search API is used.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default 5)",
          },
        },
        required: ["query"],
      },
    },
    async execute(args) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return JSON.stringify({ error: "Missing required query" });
      }

      return runner({
        action: "search",
        query,
        limit: normalizeLimit(args.limit, 5),
      });
    },
  };

  const webScrape: Tool = {
    definition: {
      name: "web_scrape",
      description:
        "Fetch and extract content from a web page locally through Scrapling. Supports optional CSS selectors and link extraction.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Absolute URL to fetch",
          },
          selector: {
            type: "string",
            description: "Optional CSS selector to scope extraction",
          },
          extract: {
            type: "string",
            description: 'Extraction mode: "text" (default) or "html"',
          },
          include_links: {
            type: "boolean",
            description: "Whether to include discovered links from the selected content",
          },
          max_chars: {
            type: "number",
            description: "Maximum content characters to return (default 6000)",
          },
        },
        required: ["url"],
      },
    },
    async execute(args) {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) {
        return JSON.stringify({ error: "Missing required url" });
      }

      const extract =
        args.extract === "html" || args.extract === "text"
          ? args.extract
          : "text";

      return runner({
        action: "scrape",
        url,
        selector: typeof args.selector === "string" ? args.selector : undefined,
        extract,
        include_links: args.include_links === true,
        max_chars: normalizeMaxChars(args.max_chars, 6000),
      });
    },
  };

  return { webSearch, webScrape };
}

export const { webSearch, webScrape } = createWebTools();
