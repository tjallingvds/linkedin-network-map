/**
 * Tavily web search — server-side. Records a usage event per call.
 */
import { env } from "../env.js";
import { recordUsage, reserveCredits } from "../usage/tracker.js";
import { CREDIT_COST } from "../billing/packs.js";
import type { UserKeys } from "./user-keys.js";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export async function tavilySearch(
  query: string,
  opts: { maxResults?: number; depth?: "basic" | "advanced"; userId?: string; userKeys?: UserKeys } = {},
): Promise<TavilyResult[]> {
  const apiKey = opts.userKeys?.tavily ?? env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");
  const byok = !!opts.userKeys?.tavily;
  const chargeUserId = byok ? undefined : opts.userId;

  // Reserve credits up front so an over-quota user can't burn Tavily credits.
  const creditCost = CREDIT_COST.tavily * (opts.depth === "advanced" ? 2 : 1);
  if (chargeUserId) await reserveCredits(chargeUserId, creditCost);

  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: opts.depth ?? "basic",
      max_results: opts.maxResults ?? 5,
      include_answer: false,
    }),
  });
  if (!r.ok) throw new Error(`tavily ${r.status}: ${await r.text()}`);
  const data = (await r.json()) as { results: TavilyResult[] };

  if (chargeUserId) {
    await recordUsage({
      userId: chargeUserId,
      provider: "tavily",
      kind: "search",
      credits: opts.depth === "advanced" ? 2 : 1, // advanced charges 2 credits
      metadata: { query: query.slice(0, 120) },
    });
  }

  return data.results ?? [];
}
