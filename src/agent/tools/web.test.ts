import { expect, test } from "bun:test";
import { createWebTools } from "./web.ts";

test("web_search forwards query and limit to the bridge", async () => {
  const calls: Record<string, unknown>[] = [];
  const { webSearch } = createWebTools(async (payload) => {
    calls.push(payload);
    return JSON.stringify({ results: [] });
  });

  const result = await webSearch.execute({ query: "scrapling", limit: 3 }, {
    cwd: "/tmp",
    agentId: "main",
    isSubAgent: false,
  });

  expect(JSON.parse(result).results).toEqual([]);
  expect(calls).toEqual([
    {
      action: "search",
      query: "scrapling",
      limit: 3,
    },
  ]);
});

test("web_scrape forwards selector and extraction options", async () => {
  const calls: Record<string, unknown>[] = [];
  const { webScrape } = createWebTools(async (payload) => {
    calls.push(payload);
    return JSON.stringify({ content: "ok" });
  });

  await webScrape.execute({
    url: "https://example.com",
    selector: "main article",
    extract: "html",
    include_links: true,
    max_chars: 1200,
  }, {
    cwd: "/tmp",
    agentId: "main",
    isSubAgent: false,
  });

  expect(calls).toEqual([
    {
      action: "scrape",
      url: "https://example.com",
      selector: "main article",
      extract: "html",
      include_links: true,
      max_chars: 1200,
    },
  ]);
});

test("web tools validate required arguments", async () => {
  const { webSearch, webScrape } = createWebTools(async () => JSON.stringify({ ok: true }));

  expect(JSON.parse(await webSearch.execute({}, {
    cwd: "/tmp",
    agentId: "main",
    isSubAgent: false,
  })).error).toContain("Missing required query");

  expect(JSON.parse(await webScrape.execute({}, {
    cwd: "/tmp",
    agentId: "main",
    isSubAgent: false,
  })).error).toContain("Missing required url");
});
