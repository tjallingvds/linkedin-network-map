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
  // We only kick the clarify LLM in when we CAN'T already pull a number out
  // of the brief — otherwise the user types "100" once, we extract 100,
  // and proceed without pestering them again.
  let requestedCount = extractCount(userInput);
  const hasTargeting = looksTargeted(userInput);

  if (!requestedCount || !hasTargeting) {
    try {
      const clarify = await aiJson<{ ready: boolean; question?: string; count?: number }>(
        provider,
        "You screen a prospecting brief before running a web search. " +
        "Require (a) some targeting (role/seniority/industry/company/region) AND (b) a specific COUNT of how many prospects the user wants. " +
        "If a count is missing, ask 'How many would you like? e.g. 10, 25, 50.' " +
        "If targeting is missing, ask ONE concise question about what's missing. " +
        "Treat the ENTIRE brief as context — numbers on their own lines DO count.",
        `Brief:\n${userInput}\n\nReturn {"ready": true, "count": <integer>} when both are clear. ` +
        `Return {"ready": false, "question": "<one line>"} otherwise.`,
        { maxTokens: 200, userId, userKeys },
      );
      if (clarify.ready === false && clarify.question) {
        return { kind: "text", content: clarify.question.trim() };
      }
      if (typeof clarify.count === "number" && clarify.count > 0) {
        requestedCount = Math.max(requestedCount, clarify.count);
      }
    } catch {
      if (!requestedCount) {
        return { kind: "text", content: "How many prospects would you like? e.g. 10, 25, 50." };
      }
    }
  }
  const count = Math.min(Math.max(requestedCount || 8, 1), 100);

  // Scale query count with target. More queries = more unique URL coverage,
  // which is the actual bottleneck when the brief asks for 25+ people.
  const queryCount =
    count <= 8  ? 3 :
    count <= 20 ? 6 :
    count <= 40 ? 9 :
    12;

  const queriesObj = await aiJson<{ queries: string[] }>(
    provider,
    "You generate specific, distinct web search queries for prospecting on LinkedIn, company blogs, press releases, and public profiles. Each query should target a different angle so the UNION of results covers many distinct people.",
    `Brief: ${userInput}\n\nReturn {"queries": [...]} — exactly ${queryCount} queries. Vary by role/seniority, specific companies in the target segment, sub-specialties, regions, and recent-hire or funding signals. Never duplicate angles. Each query self-sufficient, 6-12 words.`,
    { maxTokens: 600, userId, userKeys },
  );
  const queries = (queriesObj.queries ?? []).slice(0, queryCount);

  // Tavily returns up to ~10 per query reliably. Run in parallel, then
  // dedupe by URL so overlapping results don't steal slots.
  const perQuery = 10;
  const raw = (
    await Promise.all(
      queries.map((q) => tavilySearch(q, { maxResults: perQuery, userId, userKeys }).catch(() => [] as TavilyResult[])),
    )
  ).flat();
  const seenUrl = new Set<string>();
  const searchResults: TavilyResult[] = [];
  for (const r of raw) {
    const key = (r.url ?? "").toLowerCase();
    if (!key || seenUrl.has(key)) continue;
    seenUrl.add(key);
    searchResults.push(r);
  }

  // Extract in chunks so a single LLM call doesn't have to juggle 100+
  // snippets. Round 1 is the first batch; if we still need more, round 2
  // feeds in the remaining snippets + tells the LLM which names to skip.
  const collected: Prospect[] = [];
  const seenNames = new Set<string>();

  async function extractRound(snippets: TavilyResult[], needed: number): Promise<Prospect[]> {
    if (snippets.length === 0 || needed <= 0) return [];
    const excludeClause = seenNames.size > 0
      ? `Already captured (DO NOT repeat): ${Array.from(seenNames).slice(0, 60).join(", ")}`
      : "";
    const out = await aiJson<{ prospects: Prospect[] }>(
      provider,
      "You extract structured prospect data from web search results. Never invent contact info. Each prospect must be a DIFFERENT person.",
      `Brief: ${userInput}\n${excludeClause}\n\nSearch results (${snippets.length}):\n${JSON.stringify(
        snippets.map((r) => ({ url: r.url, title: r.title, snippet: r.content.slice(0, 480) })),
      )}\n\nReturn {"prospects": [...]} — up to ${needed} distinct prospects.\nProspect shape: {id?, name, title, company, loc?, email?, emailConf?, phone?, linkedin?, headcount?, funding?, signals: [{kind: "hot"|"fresh"|"match", text, when}], past: [{co, role, when}], matchPct}.\nOnly include contact info you can see in the sources.`,
      { maxTokens: Math.min(8000, 400 + needed * 260), userId, userKeys },
    );
    return out.prospects ?? [];
  }

  const batchSize = Math.max(20, Math.min(40, Math.ceil(count * 1.8)));
  for (let offset = 0; offset < searchResults.length && collected.length < count; offset += batchSize) {
    const batch = searchResults.slice(offset, offset + batchSize);
    const needed = count - collected.length;
    const got = await extractRound(batch, needed);
    for (const p of got) {
      const key = (p.name ?? "").toLowerCase().trim();
      if (!key || seenNames.has(key)) continue;
      seenNames.add(key);
      collected.push({
        ...p,
        id: p.id || `p${Date.now()}-${collected.length}`,
        signals: p.signals ?? [],
        past: p.past ?? [],
        matchPct: typeof p.matchPct === "number" ? p.matchPct : 80,
      });
      if (collected.length >= count) break;
    }
  }

  const summary =
    collected.length >= count
      ? `Found ${collected.length} matching ${userInput.length > 60 ? userInput.slice(0, 60) + "…" : userInput}.`
      : `Found ${collected.length} (couldn't surface ${count}) — try a more specific brief or a different angle.`;

  return { kind: "prospects", summary, prospects: collected };
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

/** Heuristic: does the brief mention who to look for (role/company/industry/
 *  region)? Good enough to skip the clarify LLM when paired with a number. */
function looksTargeted(s: string): boolean {
  if (s.trim().length < 6) return false;
  const hay = s.toLowerCase();
  // Any of these tokens implies real targeting.
  const keywords = [
    // roles / seniority
    "ceo", "cto", "cfo", "coo", "cro", "ciso", "vp", "director", "head of",
    "manager", "founder", "partner", "principal", "associate", "consultant",
    "engineer", "designer", "analyst", "lead", "chief", "president", "owner",
    "scientist", "researcher", "officer", "advisor",
    // industries / functions
    "ai", "ml", "sales", "marketing", "product", "design", "finance",
    "legal", "hr", "recruit", "customer", "operations", "strategy",
    "banking", "fintech", "saas", "biotech", "health", "retail", "media",
    "consulting", "investment",
    // companies (quick heuristic — any name-like Capitalized word of 2+ chars)
  ];
  if (keywords.some((k) => hay.includes(k))) return true;
  // Catch capitalized brand names that aren't the start-of-sentence.
  const capitalized = s.match(/\b[A-Z][a-zA-Z0-9&]{2,}/g) ?? [];
  if (capitalized.length >= 2) return true;
  return false;
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
