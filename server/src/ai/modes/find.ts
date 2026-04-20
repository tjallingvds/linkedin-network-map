/**
 * Find mode — web discovery of new prospects matching a natural-language
 * brief. Rebuilt from the legacy "parallel discovery" pipeline that
 * reliably surfaces 100+ qualified leads:
 *
 *   1. Parse the brief into structured firms / titles / exclusions (AI).
 *   2. Generate ~1.2× target count specific LinkedIn-flavoured queries.
 *   3. Fire Tavily in parallel — advanced depth, linkedin.com domain first,
 *      open-web fallback per query.
 *   4. Deduplicate URLs, chunk the snippets (40 per chunk), and extract
 *      candidates in parallel with a strict lead-qualification prompt.
 *   5. Clean + dedupe by name, apply brief-based hard filters (target firms
 *      must match, excluded firms must not).
 *   6. If we're short of target, run up to 3 rounds with exclusion lists.
 *   7. Sort high-confidence first, map to Prospect, return.
 */
import type { AiProvider, CompletionResult, Prospect, ProspectSignal } from "@app/shared";
import { env } from "../../env.js";
import { aiJson } from "../json.js";
import { tavilySearch, type TavilyResult } from "../tavily.js";
import type { UserKeys } from "../user-keys.js";

export interface PriorMessage { role: "user" | "assistant"; content: string }

// ── Intermediate shape the extraction round returns. Narrower than Prospect
//    because we still need confidence to sort/filter before returning. ──
interface Candidate {
  name: string;
  title: string;
  company: string;
  linkedin?: string;
  evidence?: string;
  confidence: "high" | "medium" | "low";
  source?: string;
}

interface ParsedBrief {
  firms: string[];
  titles: string[];
  excludeFirms: string[];
  excludeTitles: string[];
  excludeSeniority: string[];
  geography: string[];
  context: string;
}

export async function runFind(
  provider: AiProvider,
  userInput: string,
  userId: string,
  userKeys?: UserKeys,
  priorMessages: PriorMessage[] = [],
): Promise<CompletionResult> {
  assertKeys(provider, userKeys);

  const priorUserText = priorMessages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
  const fullBrief = priorUserText ? `${priorUserText}\n${userInput}` : userInput;

  // ── Clarify gate (unchanged semantics): require targeting + count. ──
  let requestedCount = extractCount(fullBrief);
  const hasTargeting = looksTargeted(fullBrief);

  if (!requestedCount || !hasTargeting) {
    try {
      const clarify = await aiJson<{ ready: boolean; question?: string; count?: number }>(
        provider,
        "You screen a prospecting brief before running a web search. " +
        "Require (a) some targeting (role/seniority/industry/company/region) AND (b) a specific COUNT of how many prospects the user wants. " +
        "If a count is missing, ask 'How many would you like? e.g. 10, 25, 50.' " +
        "If targeting is missing, ask ONE concise question about what's missing. " +
        "The brief includes the ENTIRE conversation so a bare number like \"100\" on its own line IS a count answer to an earlier clarify.",
        `Brief (oldest → newest):\n${fullBrief}\n\nReturn {"ready": true, "count": <integer>} when both are clear. ` +
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
  const targetCount = Math.min(Math.max(requestedCount || 8, 1), 200);

  // ── 1. Parse the brief into structured filters. Non-fatal if it fails. ──
  const parsed = await parseBrief(provider, fullBrief, userId, userKeys);
  const extractionHint = buildExtractionHint(parsed);

  // ── 2-7. Multi-round discovery loop. Each round runs the parallel
  //        Tavily → chunked-extraction pipeline on the unseen space.
  const collected: Candidate[] = [];
  const seenNames = new Set<string>();
  const seenUrls = new Set<string>();
  const MAX_ROUNDS = 3;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const needed = targetCount - collected.length;
    if (needed <= 0) break;

    const roundBrief = round === 0
      ? fullBrief
      : `${fullBrief}\n\n(ROUND ${round + 1}: Find DIFFERENT people. Already captured: ${
          Array.from(seenNames).slice(0, 60).join(", ")
        }. Do NOT return these.)`;

    const got = await parallelDiscovery({
      provider,
      brief: roundBrief,
      extractionHint,
      targetCount: needed,
      seenUrls,
      excludeNames: Array.from(seenNames),
      userId,
      userKeys,
    });

    let added = 0;
    for (const c of got) {
      const key = (c.name || "").toLowerCase().trim();
      if (!key || seenNames.has(key)) continue;
      seenNames.add(key);
      collected.push(c);
      added++;
      if (collected.length >= targetCount) break;
    }

    console.log(`[find] round ${round + 1}: got ${got.length} raw, added ${added} new (total ${collected.length}/${targetCount})`);

    // If a round produces almost nothing new, further rounds won't help —
    // the query space is exhausted. Break early to save credits.
    if (added < 3) break;
  }

  // ── Post-filter: clean garbage + apply brief-based hard filters.
  //    If the strict filter (target-firm match) yields 0, fall back to the
  //    loose filter (dedupe + clean only). A brief that names 40+ firms
  //    often suffers LLM-extraction drift ("Booking Holdings" vs "Booking.com")
  //    that would otherwise reject every candidate. ──
  const strict = applyPostFilters(collected, parsed);
  const loose = applyPostFilters(collected, null);
  const cleaned = strict.length > 0 ? strict : loose;
  console.log(`[find] collected=${collected.length} strict=${strict.length} loose=${loose.length} using=${cleaned.length}`);

  // ── Sort high-confidence first, then medium. ──
  const confOrder = { high: 0, medium: 1, low: 2 } as const;
  cleaned.sort((a, b) => confOrder[a.confidence] - confOrder[b.confidence]);

  // ── Map intermediate candidates to Prospect. ──
  const prospects: Prospect[] = cleaned.slice(0, targetCount).map((c, i) => {
    const signals: ProspectSignal[] = [];
    if (c.evidence) signals.push({ kind: "match", text: c.evidence, when: "" });
    return {
      id: `p${Date.now()}-${i}`,
      name: c.name,
      title: c.title,
      company: c.company,
      linkedin: normalizeLinkedInUrl(c.linkedin),
      signals,
      past: [],
      matchPct: c.confidence === "high" ? 92 : c.confidence === "medium" ? 78 : 60,
    };
  });

  const summary =
    prospects.length >= targetCount
      ? `Found ${prospects.length} matching prospects.`
      : `Found ${prospects.length} (couldn't surface ${targetCount}) — try a more specific brief or a different angle.`;

  return { kind: "prospects", summary, prospects };
}

// ──────────────────────────────────────────────────────────────────────────
// Brief parsing
// ──────────────────────────────────────────────────────────────────────────

async function parseBrief(
  provider: AiProvider,
  brief: string,
  userId: string,
  userKeys?: UserKeys,
): Promise<ParsedBrief | null> {
  try {
    const parsed = await aiJson<Partial<ParsedBrief>>(
      provider,
      `You extract structured search parameters from a research brief. Return a JSON object with:
{
  "firms": ["Company1", "Company2", ...],
  "titles": ["COO", "Chief Data Officer", ...],
  "excludeFirms": ["Goldman Sachs", "JPMorgan", ...],
  "excludeTitles": ["title pattern", ...],
  "excludeSeniority": ["Analyst", "Associate"],
  "geography": ["US", "UK", ...],
  "context": "1-2 sentence summary"
}

Rules:
- Extract EXACT company names mentioned as targets.
- Companies listed under tiers like "Tier 2 — Strong Fit", "Tier 3 — Interesting But Harder", "lower priority" etc. are STILL TARGETS. Include them in "firms". Only put a company in "excludeFirms" if the brief explicitly says to exclude / avoid / skip / not interested in that company.
- For titles use SHORT searchable keywords ("COO", "Head of AI") — not verbose ones.
- List titles in priority order (Tier 1 first).
- For excludeFirms: include ALL name variations ("JPMorgan", "J.P. Morgan", ...).
- Capture every firm and every title variant mentioned.
- If no explicit targets, leave the list empty — don't invent.`,
      `Brief:\n${brief}\n\nReturn ONLY the JSON object.`,
      { maxTokens: 1200, userId, userKeys },
    );
    return {
      firms: parsed.firms ?? [],
      titles: parsed.titles ?? [],
      excludeFirms: parsed.excludeFirms ?? [],
      excludeTitles: parsed.excludeTitles ?? [],
      excludeSeniority: parsed.excludeSeniority ?? [],
      geography: parsed.geography ?? [],
      context: parsed.context ?? "",
    };
  } catch (e) {
    console.warn("parseBrief failed:", (e as Error).message);
    return null;
  }
}

function buildExtractionHint(parsed: ParsedBrief | null): string {
  if (!parsed) return "";
  const lines: string[] = [];
  if (parsed.context) lines.push(`LOOKING FOR: ${parsed.context}`);
  if (parsed.firms.length) lines.push(`TARGET FIRMS (only extract people at these): ${parsed.firms.join(", ")}`);
  if (parsed.titles.length) lines.push(`TARGET TITLES: ${parsed.titles.join(", ")}`);
  if (parsed.excludeFirms.length) lines.push(`EXCLUDE firms: ${parsed.excludeFirms.join(", ")}`);
  if (parsed.excludeTitles.length) lines.push(`EXCLUDE titles: ${parsed.excludeTitles.join(", ")}`);
  if (parsed.excludeSeniority.length) lines.push(`EXCLUDE seniority: ${parsed.excludeSeniority.join(", ")}`);
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Parallel Tavily discovery
// ──────────────────────────────────────────────────────────────────────────

async function parallelDiscovery(args: {
  provider: AiProvider;
  brief: string;
  extractionHint: string;
  targetCount: number;
  seenUrls: Set<string>;
  excludeNames: string[];
  userId: string;
  userKeys?: UserKeys;
}): Promise<Candidate[]> {
  const { provider, brief, extractionHint, targetCount, seenUrls, excludeNames, userId, userKeys } = args;

  // Match legacy: ~1.2× target with a floor of 10. For target=100 this is
  // ~120 queries, which is what the old pipeline needed to saturate the
  // LinkedIn-profile URL space. A soft ceiling of 120 keeps extreme inputs
  // from fanning out indefinitely but doesn't clip normal large briefs.
  const numQueries = Math.min(120, Math.max(Math.ceil(targetCount * 1.2), 10));

  const queriesObj = await aiJson<{ queries: string[] }>(
    provider,
    `You generate LinkedIn search queries to find specific people. Generate exactly ${numQueries} queries from the research brief below.

${extractionHint ? `STRUCTURED FILTERS (use these exact firms, titles, and exclusions):\n${extractionHint}\n` : ""}
QUERY FORMAT — prefer queries that name a specific company when the brief lists target firms:
  GOOD: "COO Houlihan Lokey"
  GOOD: "Head of AI Evercore OR Moelis OR PJT Partners"
  GOOD: "Chief Data Officer Lazard"
  BAD:  "AI leaders investment banking" (too vague — finds thought pieces)
  BAD:  "mid-market bank COO" (no company — finds articles)

STRATEGY for ${numQueries} queries:
- Read the full brief to understand WHO we're looking for and WHY.
- When target firms are listed, pair each firm with 1-2 target titles.
- Group 2-3 similar firms with OR for broader coverage.
- Vary the title across queries so you don't search the same role 20 times.
- When no specific firms are given, vary by sub-specialty, region, and
  seniority to maximise distinct-profile coverage.
- Every query self-sufficient, 6-12 words.
- Do NOT generate queries for any EXCLUDED firms listed in the brief.

Return {"queries": [...]} with exactly ${numQueries} queries.`,
    brief,
    { maxTokens: 2000, userId, userKeys },
  );

  let searchQueries = (queriesObj.queries ?? []).filter((q): q is string => typeof q === "string" && q.trim().length > 0);
  if (searchQueries.length < 3) {
    searchQueries = [
      `${brief.slice(0, 80)} LinkedIn`,
      `${brief.slice(0, 80)} professionals`,
      `${brief.slice(0, 80)} profile`,
    ];
  }

  // Per-query result cap. Large targets pull 20; small pulls 10.
  const maxPerQuery = targetCount > 30 ? 20 : 10;

  // Fire all searches in parallel. Try linkedin.com first, fall back to
  // open web (biased with "LinkedIn profile" in the query) if the domain-
  // restricted search comes back empty.
  const searchPromises = searchQueries.map(async (sq): Promise<TavilyResult[]> => {
    const cleanQuery = sq.replace(/\s*site:\S+\s*/gi, " ").trim();
    try {
      const linked = await tavilySearch(cleanQuery, {
        depth: "advanced",
        maxResults: maxPerQuery,
        includeDomains: ["linkedin.com"],
        userId,
        userKeys,
      });
      if (linked.length > 0) return linked;
      return await tavilySearch(`${cleanQuery} LinkedIn profile`, {
        depth: "advanced",
        maxResults: maxPerQuery,
        userId,
        userKeys,
      });
    } catch {
      try {
        return await tavilySearch(cleanQuery, {
          depth: "basic",
          maxResults: 10,
          userId,
          userKeys,
        });
      } catch {
        return [];
      }
    }
  });

  const allSearchResults = await Promise.all(searchPromises);
  const allResults = allSearchResults.flat();
  if (allResults.length === 0) return [];

  // Deduplicate by URL across this round AND against prior rounds.
  const unique: TavilyResult[] = [];
  for (const r of allResults) {
    const u = (r.url ?? "").toLowerCase();
    if (!u || seenUrls.has(u)) continue;
    seenUrls.add(u);
    unique.push(r);
  }
  if (unique.length === 0) return [];

  // Chunk snippets for parallel extraction — chunks of 40 fit comfortably
  // in a single LLM call without blowing the context or missing names in
  // the middle of a 100-result dump.
  const CHUNK_SIZE = 40;
  const chunks: TavilyResult[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    chunks.push(unique.slice(i, i + CHUNK_SIZE));
  }

  const extractionPromises = chunks.map((chunk) =>
    extractChunk({ provider, chunk, extractionHint, excludeNames, userId, userKeys }),
  );
  const extractedChunks = await Promise.all(extractionPromises);
  const people = extractedChunks.flat();

  // Dedupe by name within this round — later rounds dedupe against the
  // global seenNames set.
  const seen = new Set<string>();
  return people.filter((p) => {
    const key = (p.name || "").toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Lead-qualification extraction per chunk
// ──────────────────────────────────────────────────────────────────────────

async function extractChunk(args: {
  provider: AiProvider;
  chunk: TavilyResult[];
  extractionHint: string;
  excludeNames: string[];
  userId: string;
  userKeys?: UserKeys;
}): Promise<Candidate[]> {
  const { provider, chunk, extractionHint, excludeNames, userId, userKeys } = args;
  const context = chunk
    .map((r) => `[${r.title}] (${r.url})\n${(r.content ?? "").slice(0, 600)}`)
    .join("\n\n---\n\n");

  const excludeClause = excludeNames.length
    ? `ALREADY CAPTURED (do NOT return these): ${excludeNames.slice(0, 80).join(", ")}\n`
    : "";

  try {
    const out = await aiJson<{ candidates: Candidate[] }>(
      provider,
      `You are a lead-qualification filter, not a search engine. Your job is to extract ONLY candidates that pass mandatory filters, with evidence for each.

${extractionHint ? extractionHint + "\n" : ""}${excludeClause}MANDATORY FILTERS — every candidate must pass ALL of these:
1. FULL NAME: Must have a real first AND last name (skip initials, abbreviations, "John S.").
2. CURRENT EMPLOYER: Must be verifiable from the search result. ${extractionHint ? "Strongly prefer target firms, but companies mentioned in the brief (including tier-2/tier-3 or \"harder\" labels) also count. Do NOT reject a candidate simply because the company is not a top-tier target." : ""}
3. CURRENT TITLE: Must be a real title from their profile, not inferred from article context.
4. LINKEDIN PROFILE: Strongly prefer candidates with a linkedin.com/in/ URL in the search result.

FAILURE MODES TO AVOID:
- CLUSTER HARVESTING: If an article mentions 5 people at an event, do NOT extract all 5. Each person must independently pass the filters.
- KEYWORD CONFLATION: A profile mentioning "AI" at a "bank" is NOT automatically qualified. Check the actual title and actual employer.
- ARTICLE AUTHORS/COMMENTERS: Someone who wrote an article about AI in banking is NOT a lead unless they ARE the target persona.
- STALE DATA: If the source is old, the person may have moved on. Lower confidence accordingly.

CONFIDENCE SCORING — be strict:
- "high": Current employer matches a target AND current title matches a target title AND you have a LinkedIn URL.
- "medium": Two of the three are verified, or employer/title are close but not exact matches.
- Do NOT include anyone you'd rate below medium. If you're not at least moderately confident, exclude them entirely.

Return {"candidates": [...]} — ONLY qualified candidates. Each candidate shape:
{"name":"Full Name","title":"Current Title","company":"Current Employer","linkedin":"linkedin.com/in/ URL or empty","evidence":"Specific reason they pass the filters","confidence":"high"|"medium","source":"URL"}

Do NOT pad results. If only 2 people qualify, return 2.`,
      `Search results (${chunk.length}):\n${context}`,
      { maxTokens: 4000, userId, userKeys },
    );
    return (out.candidates ?? []).filter((c) => c && c.name && c.company && c.title);
  } catch (e) {
    console.warn("extractChunk failed:", (e as Error).message);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Post-filter pipeline
// ──────────────────────────────────────────────────────────────────────────

function applyPostFilters(candidates: Candidate[], parsed: ParsedBrief | null): Candidate[] {
  let list = candidates.slice();

  // Clean garbage entries — single-word names, "unknown", etc.
  list = list.filter((c) => {
    const name = (c.name || "").trim();
    if (!name.includes(" ")) return false;
    if (name.length < 4) return false;
    if (/^(not specified|unknown|n\/a|company representative|author)/i.test(name)) return false;
    if (/^(not specified|unknown|n\/a)/i.test(c.title || "")) return false;
    return true;
  });

  // Drop explicit low-confidence stragglers (extractChunk shouldn't return
  // these but be defensive).
  list = list.filter((c) => c.confidence !== "low");

  // Dedupe by name (case-insensitive).
  const seen = new Set<string>();
  list = list.filter((c) => {
    const key = c.name.toLowerCase().trim().replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!parsed) return list;

  const exFirms = parsed.excludeFirms.map((f) => f.toLowerCase());
  const exTitles = parsed.excludeTitles.map((t) => t.toLowerCase());
  const exSeniority = parsed.excludeSeniority.map((s) => s.toLowerCase());
  const targetFirms = parsed.firms.map((f) => f.toLowerCase());

  const exFirmWords = exFirms.map((f) => f.split(/[\s,&]+/).filter((w) => w.length > 2));
  const targetFirmWords = targetFirms.map((f) => f.split(/[\s,&]+/).filter((w) => w.length > 2));

  const companyMatches = (company: string, list: string[], words: string[][]): boolean => {
    if (!company) return false;
    const c = company.toLowerCase();
    if (list.some((x) => c.includes(x) || x.includes(c))) return true;
    return words.some((ws) => {
      const matches = ws.filter((w) => c.includes(w));
      return matches.length >= 2 || (ws.length === 1 && matches.length === 1);
    });
  };

  return list.filter((cand) => {
    const title = (cand.title || "").toLowerCase();
    if (companyMatches(cand.company, exFirms, exFirmWords)) return false;
    if (exSeniority.some((s) => title.includes(s))) return false;
    if (exTitles.some((t) => title.includes(t))) return false;
    // Only enforce target firm match when the brief ACTUALLY names firms.
    // Open-ended briefs ("find me 100 AI consultants") have no target list
    // and should not be hard-filtered to zero.
    if (targetFirms.length > 0 && !companyMatches(cand.company, targetFirms, targetFirmWords)) return false;
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers (unchanged)
// ──────────────────────────────────────────────────────────────────────────

/** Normalise LinkedIn URLs returned by the LLM so <a href> actually works.
 *  The extract prompt says "linkedin.com/in/ URL or empty"; in practice
 *  models often return "linkedin.com/in/foo" with no protocol, which the
 *  browser treats as a relative path. Prepend https:// when missing. */
function normalizeLinkedInUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(www\.)?linkedin\.com\//i.test(trimmed)) return `https://${trimmed.replace(/^www\./i, "")}`;
  if (/^linkedin\.com\//i.test(trimmed)) return `https://${trimmed}`;
  // "/in/foo" → full URL; bare "in/foo" too.
  if (/^\/?in\//i.test(trimmed)) return `https://linkedin.com/${trimmed.replace(/^\//, "")}`;
  return undefined;
}

function extractCount(s: string): number {
  const m = s.match(/\b(?:find|get|give|list|top|show|want|need)\s*(?:me\s+)?(?:up\s+to\s+)?(\d{1,3})\b/i)
    ?? s.match(/\b(\d{1,3})\s*(?:prospects?|people|leads?|contacts?|results?)\b/i)
    ?? s.match(/\b(\d{1,3})\b/);
  if (!m) return 0;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function looksTargeted(s: string): boolean {
  if (s.trim().length < 6) return false;
  const hay = s.toLowerCase();
  const keywords = [
    "ceo", "cto", "cfo", "coo", "cro", "ciso", "vp", "director", "head of",
    "manager", "founder", "partner", "principal", "associate", "consultant",
    "engineer", "designer", "analyst", "lead", "chief", "president", "owner",
    "scientist", "researcher", "officer", "advisor",
    "ai", "ml", "sales", "marketing", "product", "design", "finance",
    "legal", "hr", "recruit", "customer", "operations", "strategy",
    "banking", "fintech", "saas", "biotech", "health", "retail", "media",
    "consulting", "investment",
  ];
  if (keywords.some((k) => hay.includes(k))) return true;
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
