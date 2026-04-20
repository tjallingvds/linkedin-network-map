/**
 * Tavily web search — server-side. Records a usage event per call.
 */
import { env } from "../env.js";
import { recordUsage } from "../usage/tracker.js";
import type { UserKeys } from "./user-keys.js";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export async function tavilySearch(
  query: string,
  opts: {
    maxResults?: number;
    depth?: "basic" | "advanced";
    includeDomains?: string[];
    userId?: string;
    userKeys?: UserKeys;
  } = {},
): Promise<TavilyResult[]> {
  const apiKey = opts.userKeys?.tavily ?? env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");
  const byok = !!opts.userKeys?.tavily;

  const body: Record<string, unknown> = {
    api_key: apiKey,
    query,
    search_depth: opts.depth ?? "basic",
    max_results: opts.maxResults ?? 5,
    include_answer: false,
  };
  if (opts.includeDomains && opts.includeDomains.length > 0) {
    body.include_domains = opts.includeDomains;
  }

  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`tavily ${r.status}: ${await r.text()}`);
  const data = (await r.json()) as { results: TavilyResult[] };

  if (opts.userId) {
    await recordUsage({
      userId: opts.userId,
      provider: "tavily",
      kind: "search",
      credits: opts.depth === "advanced" ? 2 : 1,
      metadata: { query: query.slice(0, 120), byok },
    });
  }

  return data.results ?? [];
}
