/**
 * Tavily web search — server-side. Records a usage event per call.
 */
import { env } from "../env.js";
import { recordUsage, reserveCredits } from "../usage/tracker.js";
import { CREDIT_COST } from "../billing/packs.js";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export async function tavilySearch(
  query: string,
  opts: { maxResults?: number; depth?: "basic" | "advanced"; userId?: string } = {},
): Promise<TavilyResult[]> {
  if (!env.TAVILY_API_KEY) throw new Error("TAVILY_API_KEY not set");

  // Reserve credits up front so an over-quota user can't burn Tavily credits.
  const creditCost = CREDIT_COST.tavily * (opts.depth === "advanced" ? 2 : 1);
  if (opts.userId) await reserveCredits(opts.userId, creditCost);

  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query,
      search_depth: opts.depth ?? "basic",
      max_results: opts.maxResults ?? 5,
      include_answer: false,
    }),
  });
  if (!r.ok) throw new Error(`tavily ${r.status}: ${await r.text()}`);
  const data = (await r.json()) as { results: TavilyResult[] };

  if (opts.userId) {
    await recordUsage({
      userId: opts.userId,
      provider: "tavily",
      kind: "search",
      credits: opts.depth === "advanced" ? 2 : 1, // advanced charges 2 credits
      metadata: { query: query.slice(0, 120) },
    });
  }

  return data.results ?? [];
}
