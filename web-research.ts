import { config } from "./config";
import type { WebResearchEntry } from "./data-boundary";

export interface WebResearchResult {
  query: string;
  results: WebResearchEntry[];
  source: "web_research";
}

async function stubSearch(query: string): Promise<WebResearchResult> {
  return { query, results: [], source: "web_research" };
}

function parseDdgResults(html: string): WebResearchEntry[] {
  const results: WebResearchEntry[] = [];
  const pattern =
    /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null && results.length < 10) {
    const rawUrl = match[1];
    const url = decodeURIComponent(
      rawUrl.replace(/.*uddg=/, "").replace(/&.*/, ""),
    );
    const title = match[2].replace(/<[^>]*>/g, "").trim();
    const snippet = match[3].replace(/<[^>]*>/g, "").trim();
    if (url && title) results.push({ title, url, snippet });
  }

  return results;
}

const DDG_TIMEOUT_MS = 8_000;

async function ddgSearch(query: string): Promise<WebResearchResult> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  // Bound the fetch: a hung search must not stall the whole tool round (the
  // dispatch path has no other deadline). Abort + degrade to empty results.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DDG_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Noah/1.0 (local assistant)" },
      signal: controller.signal,
    });

    if (!resp.ok) {
      console.warn(`[web-research] DDG returned ${resp.status}`);
      return { query, results: [], source: "web_research" };
    }

    const html = await resp.text();
    return {
      query,
      results: parseDdgResults(html).slice(0, 5),
      source: "web_research",
    };
  } catch (err) {
    console.warn("[web-research] DDG fetch failed:", err);
    return { query, results: [], source: "web_research" };
  } finally {
    clearTimeout(timer);
  }
}

export async function webResearch(
  query: string,
): Promise<WebResearchResult> {
  switch (config.webSearch.provider) {
    case "ddg":
      return ddgSearch(query);
    case "stub":
    default:
      return stubSearch(query);
  }
}
