/**
 * Find mode — web discovery of new prospects matching a natural-language query.
 * Usage is tracked per external call via `userId` passthrough.
 */
import type { AiProvider, CompletionResult, Prospect } from "@app/shared";
import { env } from "../../env.js";
import { aiJson } from "../json.js";
import { tavilySearch, type TavilyResult } from "../tavily.js";
import type { UserKeys } from "../user-keys.js";

export async function runFind(
  provider: AiProvider,
  userInput: string,
  userId: string,
  userKeys?: UserKeys,
): Promise<CompletionResult> {
  assertKeys(provider, userKeys);

  const queriesObj = await aiJson<{ queries: string[] }>(
    provider,
    "You generate concise web search queries for prospecting.",
    `Brief: ${userInput}\n\nReturn {"queries": [q1, q2, q3]} — exactly 3 specific queries that together cover the brief by title, company type, and location/industry. Make each query self-sufficient.`,
    { maxTokens: 300, userId, userKeys },
  );
  // Cap at 3 Tavily calls per Find — keeps user quotas stretching further.
  const queries = (queriesObj.queries ?? []).slice(0, 3);

  const searchResults = (
    await Promise.all(
      queries.map((q) => tavilySearch(q, { maxResults: 7, userId, userKeys }).catch(() => [] as TavilyResult[])),
    )
  ).flat();

  const extracted = await aiJson<{ summary: string; prospects: Prospect[] }>(
    provider,
    "You extract structured prospect data from web search results. Be accurate: do not invent contact info.",
    `Brief: ${userInput}\n\nSearch results (${searchResults.length} total):\n${JSON.stringify(
      searchResults.slice(0, 20).map((r) => ({ url: r.url, title: r.title, snippet: r.content.slice(0, 400) })),
    )}\n\nReturn {"summary": "<1 short sentence summary>", "prospects": [<up to 8 Prospect objects>]}.\nEach Prospect: {id, name, title, company, loc?, email?, emailConf?, phone?, linkedin?, headcount?, funding?, signals: [{kind: "hot"|"fresh"|"match", text, when}], past: [{co, role, when}], matchPct}.\nOnly include contact info you're confident about from the sources.`,
    { maxTokens: 4000, userId, userKeys },
  );

  const prospects = (extracted.prospects ?? []).map((p, i) => ({
    ...p,
    id: p.id || `p${Date.now()}-${i}`,
    signals: p.signals ?? [],
    past: p.past ?? [],
    matchPct: typeof p.matchPct === "number" ? p.matchPct : 80,
  }));

  return { kind: "prospects", summary: extracted.summary ?? "Results:", prospects };
}

function assertKeys(provider: AiProvider, userKeys?: UserKeys) {
  const tavily = userKeys?.tavily ?? env.TAVILY_API_KEY;
  if (!tavily) throw new Error("Tavily key missing — add it in Settings → API keys to enable web search.");
  const llm =
    provider === "openai" ? (userKeys?.openai ?? env.OPENAI_API_KEY) :
    provider === "anthropic" ? (userKeys?.anthropic ?? env.ANTHROPIC_API_KEY) :
    (userKeys?.deepseek ?? env.DEEPSEEK_API_KEY);
  if (!llm) throw new Error(`${provider.toUpperCase()} key missing — add it in Settings → API keys.`);
}
