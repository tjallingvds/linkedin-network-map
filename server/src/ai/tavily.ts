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

  // Hard timeout — without this, a hung Tavily request sits forever while
  // the chat route's heartbeat keeps TCP alive, and eventually the cloud
  // proxy's request cap kills the entire server process ("Failed to fetch"
  // on the client, no useful error in the logs).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let r: Response;
  try {
    r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === "AbortError") {
      throw new Error(`tavily timed out after 30s: ${query.slice(0, 80)}`);
    }
    throw err;
  }
  clearTimeout(timeout);
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
