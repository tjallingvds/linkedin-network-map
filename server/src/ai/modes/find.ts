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

  // Pre-flight: decide whether the brief is specific enough to search.
  // We REQUIRE the user to tell us how many results they want — that's the
  // most common cause of wasted searches + pointless re-runs.
  let requestedCount = extractCount(userInput);
  try {
    const clarify = await aiJson<{ ready: boolean; question?: string; count?: number }>(
      provider,
      "You screen a prospecting brief before running an expensive web search. " +
      "Require (a) some targeting (role/seniority/industry/company/region) AND (b) a specific COUNT of how many prospects the user wants. " +
      "If the brief is missing a count — even if the rest is clear — ask 'How many would you like? e.g. 10, 25, 50.' " +
      "Otherwise if the targeting is too vague, ask ONE concise question about what's missing.",
      `Brief: ${userInput}\n\nReturn {"ready": true, "count": <integer>} when the brief includes both a count and clear targeting. ` +
      `Return {"ready": false, "question": "<one line>"} otherwise. Prioritize asking for the count first.`,
      { maxTokens: 200, userId, userKeys },
    );
    if (clarify.ready === false && clarify.question) {
      return { kind: "text", content: clarify.question.trim() };
    }
    if (typeof clarify.count === "number" && clarify.count > 0) {
      requestedCount = Math.max(requestedCount, clarify.count);
    }
  } catch {
    // If the clarify LLM call fails, just proceed with the search if the
    // user already included a count; otherwise return a hard-coded prompt.
    if (!requestedCount) {
      return { kind: "text", content: "How many prospects would you like? e.g. 10, 25, 50." };
    }
  }
  // Cap to keep Tavily + LLM costs bounded. 50 is already a fat list.
  const count = Math.min(Math.max(requestedCount || 8, 1), 50);

  const queriesObj = await aiJson<{ queries: string[] }>(
    provider,
    "You generate concise web search queries for prospecting.",
    `Brief: ${userInput}\n\nReturn {"queries": [q1, q2, q3]} — exactly 3 specific queries that together cover the brief by title, company type, and location/industry. Make each query self-sufficient.`,
    { maxTokens: 300, userId, userKeys },
  );
  // Cap at 3 Tavily calls per Find — keeps user quotas stretching further.
  const queries = (queriesObj.queries ?? []).slice(0, 3);

  // Scale Tavily result width with the requested count so the LLM has
  // enough raw material to synthesize N prospects.
  const perQuery = Math.max(6, Math.ceil(count / queries.length) + 4);
  const searchResults = (
    await Promise.all(
      queries.map((q) => tavilySearch(q, { maxResults: perQuery, userId, userKeys }).catch(() => [] as TavilyResult[])),
    )
  ).flat();

  const extracted = await aiJson<{ summary: string; prospects: Prospect[] }>(
    provider,
    "You extract structured prospect data from web search results. Be accurate: do not invent contact info.",
    `Brief: ${userInput}\n\nSearch results (${searchResults.length} total):\n${JSON.stringify(
      searchResults.slice(0, Math.min(40, count * 3)).map((r) => ({ url: r.url, title: r.title, snippet: r.content.slice(0, 400) })),
    )}\n\nReturn {"summary": "<1 short sentence summary>", "prospects": [<up to ${count} Prospect objects>]}.\nEach Prospect: {id, name, title, company, loc?, email?, emailConf?, phone?, linkedin?, headcount?, funding?, signals: [{kind: "hot"|"fresh"|"match", text, when}], past: [{co, role, when}], matchPct}.\nOnly include contact info you're confident about from the sources. Return as many DISTINCT prospects as you can find — up to ${count}.`,
    { maxTokens: Math.min(8000, 500 + count * 250), userId, userKeys },
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

/** Very simple count extractor — matches common phrasings ("find me 25 …",
 *  "give me 10 prospects", "top 50"). Returns 0 if none found. */
function extractCount(s: string): number {
  const m = s.match(/\b(?:find|get|give|list|top|show|want|need)\s*(?:me\s+)?(?:up\s+to\s+)?(\d{1,3})\b/i)
    ?? s.match(/\b(\d{1,3})\s*(?:prospects?|people|leads?|contacts?|results?)\b/i)
    ?? s.match(/\b(\d{1,3})\b/);
  if (!m) return 0;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
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
