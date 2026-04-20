/**
 * Find mode — 1:1 port of the legacy discovery pipeline
 * (legacy/js/chat-discovery.js + legacy/js/enricher.js).
 *
 * Legacy flow:
 *   1. _parseBrief → structured firms/titles/exclusions.
 *   2. discover() — up to 3 rounds. Each round calls handleDiscovery,
 *      which calls Enricher.discoverPeople → _parallelDiscovery:
 *        a. Generate ~1.2× target LinkedIn-flavoured queries (floor 10).
 *        b. Fire ALL in parallel:
 *             - advanced Tavily with include_domains:['linkedin.com']
 *             - if empty: advanced Tavily with "… LinkedIn profile" open web
 *             - if throws: basic Tavily fallback
 *        c. Dedupe by URL. Chunk snippets into 40s.
 *        d. Extract in parallel with the strict lead-qualification prompt.
 *   3. _filterDiscoveryResults: dedupe-by-name, clean bad entries, apply
 *      brief filters (target-firm MUST match when firms listed; exclude
 *      firms/titles/seniority drop).
 *   4. Filter confidence != 'low', sort high → medium.
 *
 * Server-only additions that have no legacy equivalent:
 *   • clarify gate (server-side UX; legacy had a separate discovery form)
 *   • priorMessages folding (legacy kept one in-browser chat session)
 *   • normalizeLinkedInUrl (fixes <a href> on LLM-returned URLs)
 */
import type { AiProvider, CompletionResult, Prospect, ProspectSignal } from "@app/shared";
import { env } from "../../env.js";
import { aiJson } from "../json.js";
import { tavilySearch, type TavilyResult } from "../tavily.js";
import type { UserKeys } from "../user-keys.js";

export interface PriorMessage { role: "user" | "assistant"; content: string }

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

  // ── Clarify gate (server UX) ─────────────────────────────────────────────
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

  // ── Legacy: parse brief → build extractCtx ────────────────────────────────
  const parsed = await parseBrief(provider, fullBrief, userId, userKeys);
  const extractCtx = buildExtractCtx(parsed);

  // ── Legacy: multi-round discover loop ────────────────────────────────────
  const allPeople: Candidate[] = [];
  const seenNames = new Set<string>();
  const MAX_ROUNDS = 3;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const remaining = targetCount - allPeople.length;
    if (remaining <= 0) break;

    const roundQuery = round === 0
      ? fullBrief
      : `${fullBrief}\n\n(ROUND ${round + 1}: Find DIFFERENT people. Already found: ${
          allPeople.map((p) => p.name).join(", ")
        }. Do NOT return these again.)`;

    const roundPeople = await handleDiscovery({
      provider,
      query: roundQuery,
      targetCount: remaining,
      extractionHint: extractCtx,
      parsed,
      userId,
      userKeys,
    });

    if (roundPeople.length === 0) break;

    let newCount = 0;
    for (const p of roundPeople) {
      const key = (p.name || "").toLowerCase().trim();
      if (key && !seenNames.has(key)) {
        seenNames.add(key);
        allPeople.push(p);
        newCount++;
      }
    }

    console.log(`[find] round ${round + 1}: ${roundPeople.length} raw, ${newCount} new (total ${allPeople.length}/${targetCount})`);

    if (newCount < 3) break;
  }

  // ── Map Candidate → Prospect ─────────────────────────────────────────────
  const prospects: Prospect[] = allPeople.slice(0, targetCount).map((c, i) => {
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

// ═════════════════════════════════════════════════════════════════════════
// Legacy: _parseBrief (chat-discovery.js)
// ═════════════════════════════════════════════════════════════════════════

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
  "firms": ["Company1", "Company2", ...],        // target companies to search
  "titles": ["COO", "Chief Data Officer", ...],    // SHORT searchable title keywords (highest priority first)
  "excludeFirms": ["Goldman Sachs", "JPMorgan", ...],  // companies to EXCLUDE — include common name variations (e.g. both "JPMorgan" and "J.P. Morgan")
  "excludeTitles": ["title pattern", ...],        // title patterns to exclude
  "excludeSeniority": ["Analyst", "Associate"],   // seniority levels to exclude
  "geography": ["US", "UK", ...],                 // target regions
  "context": "1-2 sentence summary of what kind of person we're looking for"
}

Rules:
- Extract the EXACT company names mentioned as targets
- For titles, extract the SHORT searchable keyword (e.g. "COO", "Chief Data Officer", "CTO", "Head of AI") — NOT the full verbose title like "COO of Investment Banking Division"
- List titles in priority order (Tier 1 first, then Tier 2, etc.)
- Extract ALL explicit exclusions (companies, titles, seniority levels)
- For excludeFirms: include ALL name variations (e.g. "JPMorgan", "J.P. Morgan", "JPMorgan Chase", "Morgan Stanley", "Goldman Sachs", "Bank of America", "Barclays", etc.)
- Be thorough — capture every firm and every title variant mentioned

Return ONLY the JSON object.`,
      brief,
      { maxTokens: 1500, userId, userKeys },
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

/** Matches legacy chat-discovery.js: `extractCtx` built only when firms exist. */
function buildExtractCtx(parsed: ParsedBrief | null): string {
  if (!parsed || parsed.firms.length === 0) return "";
  let ctx = "";
  if (parsed.context) ctx += `LOOKING FOR: ${parsed.context}\n`;
  ctx += `TARGET FIRMS (only extract people at these): ${parsed.firms.join(", ")}\n`;
  if (parsed.titles.length) ctx += `TARGET TITLES: ${parsed.titles.join(", ")}\n`;
  if (parsed.excludeFirms.length) ctx += `EXCLUDE firms: ${parsed.excludeFirms.join(", ")}\n`;
  if (parsed.excludeSeniority.length) ctx += `EXCLUDE seniority: ${parsed.excludeSeniority.join(", ")}\n`;
  return ctx;
}

// ═════════════════════════════════════════════════════════════════════════
// Legacy: handleDiscovery + _filterDiscoveryResults (chat-discovery.js)
// ═════════════════════════════════════════════════════════════════════════

async function handleDiscovery(args: {
  provider: AiProvider;
  query: string;
  targetCount: number;
  extractionHint: string;
  parsed: ParsedBrief | null;
  userId: string;
  userKeys?: UserKeys;
}): Promise<Candidate[]> {
  const { provider, query, targetCount, extractionHint, parsed, userId, userKeys } = args;

  const raw = await parallelDiscovery({
    provider,
    query,
    targetCount,
    extractionHint,
    userId,
    userKeys,
  });

  if (raw.length === 0) return [];

  // Legacy _filterDiscoveryResults
  let people = raw;
  people = dedupByName(people);
  people = cleanBadEntries(people);
  people = applyBriefFilters(people, parsed);

  // Legacy handleDiscovery tail: drop low confidence, sort high→medium.
  people = people.filter((p) => p.confidence !== "low");
  const confOrder: Record<string, number> = { high: 0, medium: 1 };
  people.sort((a, b) => (confOrder[a.confidence] ?? 1) - (confOrder[b.confidence] ?? 1));

  return people;
}

function dedupByName(people: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return people.filter((p) => {
    if (!p.name) return false;
    const key = p.name.toLowerCase().trim().replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanBadEntries(people: Candidate[]): Candidate[] {
  return people.filter((p) => {
    const name = (p.name || "").trim();
    if (!name.includes(" ")) return false;
    if (name.length < 4) return false;
    if (/^(not specified|unknown|n\/a|company representative|author)/i.test(name)) return false;
    if (/^(not specified|unknown|n\/a)/i.test(p.title || "")) return false;
    return true;
  });
}

function applyBriefFilters(people: Candidate[], parsed: ParsedBrief | null): Candidate[] {
  if (!parsed) return people;

  const exFirms = parsed.excludeFirms.map((f) => f.toLowerCase());
  const exTitles = parsed.excludeTitles.map((t) => t.toLowerCase());
  const exSeniority = parsed.excludeSeniority.map((s) => s.toLowerCase());
  const targetFirms = parsed.firms.map((f) => f.toLowerCase());

  const exFirmWords = exFirms.map((f) => f.split(/[\s,&]+/).filter((w) => w.length > 2));
  const targetFirmWords = targetFirms.map((f) => f.split(/[\s,&]+/).filter((w) => w.length > 2));

  const companyMatchesExcluded = (company: string): boolean => {
    if (!company) return false;
    const c = company.toLowerCase();
    if (exFirms.some((ef) => c.includes(ef) || ef.includes(c))) return true;
    return exFirmWords.some((words) => {
      const matches = words.filter((w) => c.includes(w));
      return matches.length >= 2 || (words.length === 1 && matches.length === 1);
    });
  };

  const companyMatchesTarget = (company: string): boolean => {
    if (!company) return false;
    const c = company.toLowerCase();
    if (targetFirms.some((tf) => c.includes(tf) || tf.includes(c))) return true;
    return targetFirmWords.some((words) => {
      const matches = words.filter((w) => c.includes(w));
      return matches.length >= 2 || (words.length === 1 && matches.length === 1);
    });
  };

  const before = people.length;
  const filtered = people.filter((p) => {
    const title = (p.title || "").toLowerCase();
    if (companyMatchesExcluded(p.company)) return false;
    if (exSeniority.some((es) => title.includes(es))) return false;
    if (exTitles.some((et) => title.includes(et))) return false;
    if (targetFirms.length > 0 && !companyMatchesTarget(p.company)) return false;
    return true;
  });
  console.log(`[find] brief filter: ${before} → ${filtered.length}`);
  return filtered;
}

// ═════════════════════════════════════════════════════════════════════════
// Legacy: Enricher._parallelDiscovery (enricher.js)
// ═════════════════════════════════════════════════════════════════════════

async function parallelDiscovery(args: {
  provider: AiProvider;
  query: string;
  targetCount: number;
  extractionHint: string;
  userId: string;
  userKeys?: UserKeys;
}): Promise<Candidate[]> {
  const { provider, query, targetCount, extractionHint, userId, userKeys } = args;

  // Legacy: max(ceil(targetCount * 1.2), 10)
  const numQueries = Math.max(Math.ceil(targetCount * 1.2), 10);

  const queriesObj = await aiJson<{ queries: string[] }>(
    provider,
    `You generate LinkedIn search queries to find specific people. Generate exactly ${numQueries} queries from the research brief below.

${extractionHint ? `STRUCTURED FILTERS (use these exact firms, titles, and exclusions):\n${extractionHint}\n` : ""}
QUERY FORMAT — every query MUST name a specific company from the brief:
  GOOD: "COO Houlihan Lokey"
  GOOD: "Head of AI Evercore OR Moelis OR PJT Partners"
  GOOD: "Chief Data Officer Lazard"
  GOOD: "Raymond James Head of AI strategy"
  BAD:  "AI leaders investment banking" (no company name — finds articles, not people)
  BAD:  "mid-market bank COO" (no company name — too vague)
  BAD:  "digital transformation financial services" (finds thought leadership, not profiles)

STRATEGY for ${numQueries} queries:
- Read the full brief to understand WHO we're looking for and WHY
- Pair each target firm with 1-2 target titles from the brief
- Group 2-3 similar firms with OR for broader coverage
- Every query must contain at least one specific company name from the brief
- Vary the title across queries so you don't search the same role 20 times
- Do NOT generate queries for any EXCLUDED firms listed in the brief or filters above

Return {"queries": [...]} — exactly ${numQueries} queries.`,
    query,
    { maxTokens: 2000, userId, userKeys },
  );

  let searchQueries = (queriesObj.queries ?? []).filter(
    (q): q is string => typeof q === "string" && q.trim().length > 0,
  );
  if (searchQueries.length < 3) {
    searchQueries = [
      `${query.slice(0, 80)} LinkedIn`,
      `${query.slice(0, 80)} professionals`,
    ];
  }

  // Legacy: maxPerQuery = targetCount > 30 ? 20 : 10
  const maxPerQuery = targetCount > 30 ? 20 : 10;

  const searchPromises = searchQueries.map(async (sq): Promise<TavilyResult[]> => {
    const cleanQuery = sq.replace(/\s*site:\S+\s*/gi, " ").trim();
    try {
      // 1. Advanced + include_domains: linkedin.com
      const linked = await tavilySearch(cleanQuery, {
        depth: "advanced",
        maxResults: maxPerQuery,
        includeDomains: ["linkedin.com"],
        userId,
        userKeys,
      });
      if (linked.length > 0) return linked;
      // 2. Advanced + "LinkedIn profile" suffix, open web
      return await tavilySearch(`${cleanQuery} LinkedIn profile`, {
        depth: "advanced",
        maxResults: maxPerQuery,
        userId,
        userKeys,
      });
    } catch {
      // 3. Basic fallback
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

  // Dedupe by URL
  const seenUrls = new Set<string>();
  const unique: TavilyResult[] = [];
  for (const r of allResults) {
    if (!r.url || seenUrls.has(r.url)) continue;
    seenUrls.add(r.url);
    unique.push(r);
  }

  console.log(`[find] parallel: ${searchQueries.length} queries → ${allResults.length} raw → ${unique.length} unique URLs`);

  // Legacy CHUNK_SIZE = 40
  const CHUNK_SIZE = 40;
  const chunks: TavilyResult[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    chunks.push(unique.slice(i, i + CHUNK_SIZE));
  }

  const extractionPromises = chunks.map((chunk) =>
    extractChunk({ provider, chunk, extractionHint, userId, userKeys }),
  );
  const extractedChunks = await Promise.all(extractionPromises);
  const allPeople = extractedChunks.flat();

  // Dedupe by name (parallelDiscovery's own dedup — handleDiscovery will
  // dedupe again after the filter pipeline)
  const nameSet = new Set<string>();
  return allPeople.filter((p) => {
    if (!p.name) return false;
    const key = p.name.toLowerCase().trim();
    if (nameSet.has(key)) return false;
    nameSet.add(key);
    return true;
  });
}

// ═════════════════════════════════════════════════════════════════════════
// Legacy: extraction prompt (enricher.js _parallelDiscovery chunk prompt)
// ═════════════════════════════════════════════════════════════════════════

async function extractChunk(args: {
  provider: AiProvider;
  chunk: TavilyResult[];
  extractionHint: string;
  userId: string;
  userKeys?: UserKeys;
}): Promise<Candidate[]> {
  const { provider, chunk, extractionHint, userId, userKeys } = args;
  // Legacy passed r.content verbatim (no slicing).
  const context = chunk
    .map((r) => `[${r.title}] (${r.url})\n${r.content ?? ""}`)
    .join("\n\n---\n\n");

  try {
    const out = await aiJson<{ candidates: Candidate[] }>(
      provider,
      `You are a lead qualification filter, not a search engine. Your job is to extract ONLY candidates that pass mandatory filters, with evidence for each.

${extractionHint ? extractionHint + "\n" : ""}MANDATORY FILTERS — every candidate must pass ALL of these:
1. FULL NAME: Must have a real first AND last name (skip initials, abbreviations, "John S.")
2. CURRENT EMPLOYER: Must be verifiable from the search result. ${extractionHint ? "Must match a TARGET FIRM listed above." : ""}
3. CURRENT TITLE: Must be a real title from their LinkedIn profile, not inferred from article context
4. LINKEDIN PROFILE: Strongly prefer candidates with a linkedin.com/in/ URL in the search result

FAILURE MODES TO AVOID:
- CLUSTER HARVESTING: If an article mentions 5 people at an event, do NOT extract all 5. Each person must independently pass the filters.
- KEYWORD CONFLATION: A profile mentioning "AI" at a "bank" is NOT automatically qualified. Check the actual title and actual employer.
- ARTICLE AUTHORS/COMMENTERS: Someone who wrote an article about AI in banking is NOT a lead. Only extract people who ARE the target persona, not people who WRITE ABOUT the target persona.
- STALE DATA: If the source is old, the person may have moved on. Note uncertainty.

CONFIDENCE SCORING — be strict:
- "high": Current employer is a target firm AND current title matches a target title AND you have a LinkedIn URL. All three verified.
- "medium": Two of the three are verified, or employer/title are close but not exact matches.
- Do NOT include anyone you'd rate below medium. If you're not at least moderately confident they match, exclude them entirely.

Return {"candidates": [...]} of ONLY qualified candidates (high or medium confidence). Each candidate:
{"name":"Full Name","title":"Current Title","company":"Current Employer","linkedin":"linkedin.com/in/ URL or empty","evidence":"Specific reason they pass the filters","confidence":"high"|"medium","source":"URL"}

Do NOT pad results. If only 2 people qualify, return 2.`,
      context,
      { maxTokens: 4000, userId, userKeys },
    );
    return (out.candidates ?? []).filter((c) => c && c.name && c.company && c.title);
  } catch (e) {
    console.warn("extractChunk failed:", (e as Error).message);
    return [];
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Helpers (non-legacy: clarify gate heuristics + LinkedIn URL normalization)
// ═════════════════════════════════════════════════════════════════════════

function normalizeLinkedInUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(www\.)?linkedin\.com\//i.test(trimmed)) return `https://${trimmed.replace(/^www\./i, "")}`;
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
