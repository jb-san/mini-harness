#!/usr/bin/env python3
import json
import logging
import sys
from html import unescape
from typing import Any
from urllib.parse import parse_qs, unquote, urljoin, urlparse

logging.disable(logging.CRITICAL)


def emit(payload: dict[str, Any], exit_code: int = 0) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(exit_code)


try:
    from scrapling import Fetcher
except ModuleNotFoundError:
    emit(
        {
            "error": (
                "Scrapling fetchers are not installed. Run "
                '`python3 -m pip install "scrapling[fetchers]"`.'
            )
        },
        2,
    )
except Exception as exc:
    emit({"error": f"Failed to import Scrapling: {exc}"}, 2)


def normalize_whitespace(text: str) -> str:
    return " ".join(unescape(text).split())


def decode_duckduckgo_url(raw_url: str) -> str:
    if not raw_url:
        return ""
    if raw_url.startswith("//"):
      raw_url = f"https:{raw_url}"
    parsed = urlparse(raw_url)
    if "duckduckgo.com" not in parsed.netloc:
        return raw_url
    params = parse_qs(parsed.query)
    uddg = params.get("uddg", [])
    return unquote(uddg[0]) if uddg else raw_url


def run_search(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(payload.get("query", "")).strip()
    if not query:
        return {"error": "Missing required query"}

    limit = int(payload.get("limit", 5) or 5)
    page = Fetcher.get(
        "https://html.duckduckgo.com/html/",
        params={"q": query},
        timeout=20,
        follow_redirects=True,
    )

    results = []
    for node in page.css(".result"):
        href = decode_duckduckgo_url(node.css(".result__title a::attr(href)").get() or "")
        title = normalize_whitespace(node.css(".result__title a::text").get() or "")
        snippet = normalize_whitespace(node.css(".result__snippet::text").get() or "")
        if not href or not title:
            continue
        results.append({"title": title, "url": href, "snippet": snippet})
        if len(results) >= limit:
            break

    return {"engine": "duckduckgo", "query": query, "results": results}


def run_scrape(payload: dict[str, Any]) -> dict[str, Any]:
    url = str(payload.get("url", "")).strip()
    if not url:
        return {"error": "Missing required url"}

    selector = payload.get("selector")
    include_links = bool(payload.get("include_links", False))
    extract = str(payload.get("extract", "text")).strip().lower()
    max_chars = int(payload.get("max_chars", 6000) or 6000)

    page = Fetcher.get(
        url,
        timeout=30,
        follow_redirects=True,
    )

    target = page
    if selector:
        matches = page.css(str(selector))
        if not matches:
            return {
                "url": url,
                "final_url": page.url,
                "title": normalize_whitespace(page.css("title::text").get() or ""),
                "content": "",
                "links": [],
                "error": f"No elements matched selector: {selector}",
            }
        target = matches[0]

    if extract == "html":
        content = target.html_content
    else:
        content = normalize_whitespace(target.get_all_text())

    links: list[str] = []
    if include_links:
        seen = set()
        for href in target.css("a::attr(href)").getall():
            if not href:
                continue
            absolute = urljoin(page.url, href)
            if absolute in seen:
                continue
            seen.add(absolute)
            links.append(absolute)
            if len(links) >= 25:
                break

    return {
        "url": url,
        "final_url": page.url,
        "title": normalize_whitespace(page.css("title::text").get() or ""),
        "content": content[:max_chars],
        "links": links,
    }


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:
        emit({"error": f"Failed to parse input JSON: {exc}"}, 1)

    action = payload.get("action")
    try:
        if action == "search":
            emit(run_search(payload))
        if action == "scrape":
            emit(run_scrape(payload))
        emit({"error": f"Unsupported action: {action}"}, 1)
    except Exception as exc:
        emit({"error": str(exc)}, 1)


if __name__ == "__main__":
    main()
