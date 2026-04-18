/**
 * discover_more — re-run the original Find against the web, excluding names
 * the user has already seen. Produces a fresh batch of prospects without
 * burning credits on re-parsing the brief.
 */
import type { AiProvider, CompletionResult, Prospect } from "@app/shared";
import { env } from "../../env.js";
import { aiJson } from "../json.js";
import { tavilySearch, type TavilyResult } from "../tavily.js";
import type { UserKeys } from "../user-keys.js";

export async function runDiscoverMore(
  provider: AiProvider,
  originalBrief: string,
  excludeNames: string[],
  userId: string,
  userKeys?: UserKeys,
): Promise<CompletionResult> {
  assertKeys(provider, userKeys);

  const exclusionClause = excludeNames.length
    ? `Already shown (exclude these from results): ${excludeNames.slice(0, 40).join(", ")}`
    : "";

  const queriesObj = await aiJson<{ queries: string[] }>(
    provider,
    "You generate web search queries for prospecting, optimised for discovering NEW results beyond what's already been shown.",
    `Brief: ${originalBrief}\n${exclusionClause}\n\nReturn {"queries": [q1, q2, q3]} — 3 queries that approach the brief from different angles (regions, sub-specialties, parallel industries) to surface fresh candidates.`,
    { maxTokens: 300, userId, userKeys },
  );
  const queries = (queriesObj.queries ?? []).slice(0, 3);

  const searchResults = (
    await Promise.all(
      queries.map((q) => tavilySearch(q, { maxResults: 7, userId, userKeys }).catch(() => [] as TavilyResult[])),
    )
  ).flat();

  const extracted = await aiJson<{ summary: string; prospects: Prospect[] }>(
    provider,
    "You extract structured prospect data. Do NOT invent contact info. Skip anyone in the exclude list.",
    `Brief: ${originalBrief}\n${exclusionClause}\n\nSearch results:\n${JSON.stringify(
      searchResults.slice(0, 20).map((r) => ({ url: r.url, title: r.title, snippet: r.content.slice(0, 400) })),
    )}\n\nReturn {"summary": "<1 sentence>", "prospects": [<up to 8 Prospect objects>]}.\nSame Prospect shape as the first pass. Exclude anyone named in the "already shown" list above.`,
    { maxTokens: 4000, userId, userKeys },
  );

  const excluded = new Set(excludeNames.map((n) => n.toLowerCase()));
  const prospects = (extracted.prospects ?? [])
    .filter((p) => !excluded.has((p.name ?? "").toLowerCase()))
    .map((p, i) => ({
      ...p,
      id: p.id || `more-${Date.now()}-${i}`,
      signals: p.signals ?? [],
      past: p.past ?? [],
      matchPct: typeof p.matchPct === "number" ? p.matchPct : 78,
    }));

  return {
    kind: "prospects",
    summary: extracted.summary ?? `${prospects.length} more matches.`,
    prospects,
  };
}

function assertKeys(provider: AiProvider, userKeys?: UserKeys) {
  if (!(userKeys?.tavily ?? env.TAVILY_API_KEY)) {
    throw new Error("Tavily key missing — add it in Settings → API keys to enable web search.");
  }
  const llm =
    provider === "openai" ? (userKeys?.openai ?? env.OPENAI_API_KEY) :
    provider === "anthropic" ? (userKeys?.anthropic ?? env.ANTHROPIC_API_KEY) :
    (userKeys?.deepseek ?? env.DEEPSEEK_API_KEY);
  if (!llm) throw new Error(`${provider.toUpperCase()} key missing — add it in Settings → API keys.`);
}
