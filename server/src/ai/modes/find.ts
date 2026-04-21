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
import { looksLikeDecisionMakerMap, runDecisionMakers } from "./decision-makers.js";

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
  /** Names already shown earlier in this chat — pre-seeded into seenNames
   *  so a subsequent Find in the same chat doesn't re-surface them. Driven
   *  from messages.result.prospects in the DB by chats.ts. */
  alreadyShownNames: string[] = [],
): Promise<CompletionResult> {
  assertKeys(provider, userKeys);

  const priorUserText = priorMessages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
  const fullBrief = priorUserText ? `${priorUserText}\n${userInput}` : userInput;

  // ── Decision-maker / buying-committee fast path ─────────────────────────
  // "I want to sell X to Morgan Stanley, map the decision makers and how
  // they relate" — fan out a tailored role search, assign committee roles,
  // write a narrative. Runs BEFORE clarify so the user isn't asked "how
  // many?" for what's structurally a 1-company org map.
  if (looksLikeDecisionMakerMap(fullBrief)) {
    const dm = await runDecisionMakers(provider, fullBrief, userId, userKeys);
    if (dm) return dm;
    // Fall through to the generic pipeline only if parsing failed (no
    // company extractable).
  }

  // ── Clarify gate (server UX) ─────────────────────────────────────────────
  let requestedCount = extractCount(fullBrief);
  const hasTargeting = looksTargeted(fullBrief);
  // Specific-person lookups ("find someone named X at Y", "identify Bert Shannon
  // at Morgan Stanley") don't need a count — they're a 1-person search. Skip
  // clarify entirely so the user isn't bounced through "how many?" / "what
  // role?" prompts when they've already named the person.
  const isNameLookup = looksLikeSpecificPersonLookup(fullBrief);
  if (isNameLookup && !requestedCount) requestedCount = 1;

  // ── Name-lookup fast path ────────────────────────────────────────────────
  // The multi-prospect pipeline below extracts people BY TITLE — the user's
  // target name ("Bert Shannon") falls off the floor. When we detect a
  // specific-person lookup, run a dedicated branch that queries variants of
  // the name and ranks candidates by phonetic/edit-distance similarity.
  if (isNameLookup) {
    const nameResult = await runNameLookup({
      provider,
      brief: fullBrief,
      userId,
      userKeys,
    });
    if (nameResult) return nameResult;
    // Fall through to the generic pipeline only if name extraction failed.
  }

  // "all / everyone / every" with no explicit number means "a big list, pick a
  // sensible default" — NOT count=1. Past regression: the clarify LLM was
  // returning {ready:true, count:1} for briefs like "find me all people at X"
  // and the user got a single prospect back. Default to 50 when the user said
  // "all" and also skip the clarify round-trip so they don't get quizzed.
  const saysAll = /\b(?:all|every(?:one|body)?|each)\s+(?:of\s+the\s+)?(?:people|person|employees|contacts|prospects|staff|folks)?\b/i.test(fullBrief);
  if (saysAll && !requestedCount) {
    requestedCount = 50;
  }

  if ((!requestedCount || !hasTargeting) && !isNameLookup) {
    try {
      const clarify = await aiJson<{ ready: boolean; question?: string; count?: number }>(
        provider,
        "You screen a prospecting brief before running a web search. " +
        "Require (a) some targeting (role/seniority/industry/company/region) AND (b) a specific COUNT of how many prospects the user wants. " +
        "If a count is missing, ask 'How many would you like? e.g. 25, 50, 100, 200.' — do NOT invent a count. " +
        "NEVER return count=1 unless the user literally typed '1' or 'one' — 'find me people' without a number means they want MANY, not one. " +
        "If targeting is missing, ask ONE concise question about what's missing. " +
        "The brief includes the ENTIRE conversation so a bare number like \"100\" on its own line IS a count answer to an earlier clarify.",
        `Brief (oldest → newest):\n${fullBrief}\n\nReturn {"ready": true, "count": <integer ≥ 5>} when both are clear. ` +
        `Return {"ready": false, "question": "<one line>"} otherwise.`,
        { maxTokens: 200, userId, userKeys },
      );
      if (clarify.ready === false && clarify.question) {
        return { kind: "text", content: clarify.question.trim() };
      }
      if (typeof clarify.count === "number" && clarify.count > 1) {
        // Reject count=1 — almost certainly a hallucination for a multi-
        // prospect brief. Name lookups (count=1) were handled above.
        requestedCount = Math.max(requestedCount, clarify.count);
      } else if (typeof clarify.count === "number" && clarify.count === 1 && !requestedCount) {
        // LLM tried to stick us with count=1; ask the user instead.
        return {
          kind: "text",
          content: "How many prospects would you like? e.g. 25, 50, 100, 200.",
        };
      }
    } catch {
      if (!requestedCount) {
        return { kind: "text", content: "How many prospects would you like? e.g. 25, 50, 100, 200." };
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
  // Pre-seed with names already shown earlier in this chat so cross-turn
  // dedup works. Without this, turn 3 ("find everyone at JPM/Barclays/…")
  // happily returned people turn 1 ("find everyone at Goldman Sachs")
  // already surfaced — which the user saw and called out.
  for (const n of alreadyShownNames) {
    const key = n.toLowerCase().trim();
    if (key) seenNames.add(key);
  }
  const MAX_ROUNDS = 3;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const remaining = targetCount - allPeople.length;
    if (remaining <= 0) break;

    // When round > 0, include the names we've found THIS request in the
    // exclusion list for the query generator. When pre-seed has entries,
    // surface the first slice on round 0 too so Tavily queries don't aim
    // at the same LinkedIn profiles again.
    const priorShownSlice = round === 0 && alreadyShownNames.length > 0
      ? `\n\n(Already shown in earlier chat turns — do NOT return these: ${alreadyShownNames.slice(0, 80).join(", ")}.)`
      : "";
    const roundQuery = round === 0
      ? `${fullBrief}${priorShownSlice}`
      : `${fullBrief}\n\n(ROUND ${round + 1}: Find DIFFERENT people. Already found: ${
          allPeople.map((p) => p.name).join(", ")
        }${alreadyShownNames.length ? "; Also already shown earlier: " + alreadyShownNames.slice(0, 40).join(", ") : ""}. Do NOT return these again.)`;

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
// Name-lookup branch — "find someone called X at Y"
// ═════════════════════════════════════════════════════════════════════════

interface NameBrief {
  /** The user's best guess at the person's name, as written (e.g. "Bert Shannon"). */
  name: string;
  /** Alternate spellings / phonetic variants. LLM-generated, user's guess included. */
  variants: string[];
  /** Company the person works at, if named. */
  company?: string;
  /** 1-line description of what they do (role, team, focus) — used to pick
   *  between near-duplicate name hits, not to filter the initial search. */
  roleContext?: string;
}

async function runNameLookup(args: {
  provider: AiProvider;
  brief: string;
  userId: string;
  userKeys?: UserKeys;
}): Promise<CompletionResult | null> {
  const { provider, brief, userId, userKeys } = args;

  // Step 1 — extract the target name + variants from the brief.
  const parsed = await extractNameBrief(provider, brief, userId, userKeys);
  if (!parsed || !parsed.name) {
    console.warn("[name-lookup] could not extract name — falling back to generic Find");
    return null;
  }

  const variants = uniqueNames([parsed.name, ...parsed.variants]);
  console.log(`[name-lookup] target="${parsed.name}" company="${parsed.company ?? "(unspecified)"}" variants=${variants.length}`);

  // Step 2 — run Tavily searches in parallel. Two complementary strategies:
  //   (a) name-first: one query per variant ("Burt Shannon" Morgan Stanley)
  //   (b) reverse: company + role context (Morgan Stanley "AI implementation"
  //       OR "backoffice automation") — catches the case where the name is
  //       further off than any variant we guessed, so variant-based search
  //       finds nothing AT the company.
  const company = parsed.company?.trim() ?? "";
  const nameQueries = variants.map((v) => (company ? `"${v}" ${company}` : `"${v}"`));
  const reverseQueries: string[] = [];
  if (company && parsed.roleContext) {
    const phrases = Array.from(new Set(
      parsed.roleContext
        .split(/\s+and\s+|,|;/i)
        .map((s) => s.trim())
        .filter((s) => s.length >= 4)
        .slice(0, 4),
    ));
    if (phrases.length) {
      reverseQueries.push(
        `${company} ${phrases.map((p) => `"${p}"`).join(" OR ")}`,
      );
    } else {
      reverseQueries.push(`${company} "${parsed.roleContext.slice(0, 60)}"`);
    }
  }
  const tavilyQueries = [...nameQueries, ...reverseQueries];

  const searchResults = await Promise.all(
    tavilyQueries.map(async (q) => {
      try {
        const linked = await tavilySearch(q, {
          depth: "advanced",
          maxResults: 8,
          includeDomains: ["linkedin.com"],
          userId,
          userKeys,
        });
        if (linked.length > 0) return linked;
        // Fallback: open web with "LinkedIn" suffix.
        return await tavilySearch(`${q} LinkedIn`, {
          depth: "advanced",
          maxResults: 8,
          userId,
          userKeys,
        });
      } catch {
        return [] as TavilyResult[];
      }
    }),
  );
  const flat = searchResults.flat();

  // Dedup by URL.
  const seenUrls = new Set<string>();
  const unique: TavilyResult[] = [];
  for (const r of flat) {
    if (!r.url || seenUrls.has(r.url)) continue;
    seenUrls.add(r.url);
    unique.push(r);
  }
  console.log(`[name-lookup] ${tavilyQueries.length} queries → ${flat.length} raw → ${unique.length} unique URLs`);

  if (unique.length === 0) {
    return {
      kind: "text",
      content: `Couldn't find a public profile matching "${parsed.name}"${company ? ` at ${company}` : ""}. Double-check the name spelling or add more context (role, team, location).`,
    };
  }

  // Step 3 — extract candidates from the LinkedIn snippets. Name-match
  // prompt, NOT title-match, so we don't anchor on "COO Morgan Stanley".
  const context = unique
    .slice(0, 40)
    .map((r) => `[${r.title}] (${r.url})\n${r.content ?? ""}`)
    .join("\n\n---\n\n");
  const companyHint = company ? ` at ${company}` : "";
  let extracted: Candidate[] = [];
  try {
    const out = await aiJson<{ candidates: Candidate[] }>(
      provider,
      `You extract LinkedIn profiles that plausibly match a specific person. The user heard a name on a call (transcription possibly wrong) and wants to ID them on LinkedIn.

Target name: "${parsed.name}"${companyHint}
Known name variants: ${variants.join(", ")}
${parsed.roleContext ? `Role context (helpful signal): ${parsed.roleContext}` : ""}

TWO KINDS OF CANDIDATES ARE OK:
  A. Name-close candidate: name is phonetically / visually close to a variant above.
  B. Company+role candidate: name is further from the variants, but the person's CURRENT employer is ${company ? `"${company}"` : "the target company"} AND their role matches the role context. This catches mis-transcribed names.

HARD RULES
- "company" field MUST be the person's CURRENT employer — the one listed as their *most recent* Experience on LinkedIn, or stated in the snippet as where they work now. NEVER put a firm that's merely mentioned in a recommendation, event, prior role, or client list.
- If the snippet doesn't clearly state the current employer, skip that person entirely.
- Prefer results with a linkedin.com/in/ URL; skip article authors and commenters.
- Do NOT return someone who's NEITHER name-close NOR at the target company.

Return {"candidates": [...]} with at most 10 items:
{"name":"Full Name","title":"Current Title","company":"Current Employer","linkedin":"linkedin.com/in/ URL or empty","evidence":"Why this is plausibly the target (name similarity or company+role fit)","confidence":"high"|"medium"|"low","source":"URL"}`,
      context,
      { maxTokens: 3000, userId, userKeys },
    );
    extracted = (out.candidates ?? []).filter((c) => c && c.name && c.company);
  } catch (e) {
    console.warn("[name-lookup] extraction failed:", (e as Error).message);
  }

  if (extracted.length === 0) {
    return {
      kind: "text",
      content: `Couldn't confidently match "${parsed.name}"${company ? ` at ${company}` : ""} to a LinkedIn profile. Try adding a middle name, team, or location.`,
    };
  }

  // Step 4 — score by edit-distance to the closest variant; HARD FILTER by
  // company when one was specified (Morgan Stanley is not a tiebreaker — if
  // the user said Morgan Stanley, results at Sonablate/Standard Electric are
  // noise and should not show up at all). Role context remains a tiebreaker.
  const wantCompany = (company || "").toLowerCase();
  const wantRole = (parsed.roleContext || "").toLowerCase();
  const scored = extracted.map((c) => {
    const nameScore = bestNameSimilarity(c.name, variants);
    const companyHay = (c.company || "").toLowerCase();
    const companyMatch =
      wantCompany &&
      (companyHay.includes(wantCompany) || wantCompany.includes(companyHay && companyHay.length > 3 ? companyHay : "\0"))
        ? 1
        : 0;
    const roleMatch =
      wantRole &&
      [c.title, c.evidence]
        .filter(Boolean)
        .some((s) => {
          const hay = String(s).toLowerCase();
          return wantRole
            .split(/\W+/)
            .filter((w) => w.length > 3)
            .some((w) => hay.includes(w));
        })
        ? 1
        : 0;
    return { c, nameScore, companyMatch, roleMatch };
  });

  // Drop name-far candidates UNLESS they're at the target company (the reverse
  // search exists precisely to catch names that are further off than any
  // variant — filtering those out here would defeat it).
  const MAX_DISTANCE = 5;
  let ranked = scored.filter((s) => s.nameScore <= MAX_DISTANCE || s.companyMatch === 1);

  // Hard company filter. If the user said "at Morgan Stanley", we only want
  // people AT Morgan Stanley — better to return nothing than noise.
  if (wantCompany) {
    const atCompany = ranked.filter((s) => s.companyMatch === 1);
    if (atCompany.length > 0) {
      ranked = atCompany;
    } else {
      const nearMisses = ranked
        .slice(0, 3)
        .map((s) => `${s.c.name} (${s.c.company || "unknown"})`)
        .join(", ");
      return {
        kind: "text",
        content:
          `No public LinkedIn match for "${parsed.name}"-like names at ${company}. ` +
          (nearMisses
            ? `Closest web hits at other companies: ${nearMisses}. `
            : "") +
          `Try adding a team ("AI COE", "operations transformation"), a location, or any middle name you remember.`,
      };
    }
  }

  ranked.sort((a, b) => {
    if (a.nameScore !== b.nameScore) return a.nameScore - b.nameScore;
    if (a.companyMatch !== b.companyMatch) return b.companyMatch - a.companyMatch;
    return b.roleMatch - a.roleMatch;
  });

  if (ranked.length === 0) {
    return {
      kind: "text",
      content: `Couldn't confidently match "${parsed.name}"${company ? ` at ${company}` : ""}.`,
    };
  }

  const prospects: Prospect[] = ranked.slice(0, 5).map(({ c, nameScore, companyMatch, roleMatch }, i) => {
    const signals: ProspectSignal[] = [];
    const similarity = nameScore === 0 ? "exact name match" : `~${nameScore}-char edit distance from "${parsed.name}"`;
    signals.push({ kind: "match", text: similarity, when: "" });
    if (c.evidence) signals.push({ kind: "match", text: c.evidence, when: "" });
    const matchPct =
      nameScore === 0 ? 95 :
      nameScore <= 2 ? 85 :
      nameScore <= 4 ? 72 : 60;
    const bump = companyMatch * 3 + roleMatch * 2;
    return {
      id: `p${Date.now()}-${i}`,
      name: c.name,
      title: c.title,
      company: c.company,
      linkedin: normalizeLinkedInUrl(c.linkedin),
      signals,
      past: [],
      matchPct: Math.min(99, matchPct + bump),
    };
  });

  const top = ranked[0]!;
  const summary =
    prospects.length === 1
      ? `Likely match: ${top.c.name} (${top.c.title}${top.c.company ? `, ${top.c.company}` : ""}).`
      : `${prospects.length} plausible name matches — closest first.`;

  return { kind: "prospects", summary, prospects };
}

async function extractNameBrief(
  provider: AiProvider,
  brief: string,
  userId: string,
  userKeys?: UserKeys,
): Promise<NameBrief | null> {
  try {
    const out = await aiJson<NameBrief>(
      provider,
      `You extract a person-lookup brief. The user heard a name on a call and the transcription may be wrong — they want to ID the person on LinkedIn.

Return JSON:
{
  "name": "best guess at the person's name, as the user wrote it",
  "variants": ["5-10 plausible phonetic/spelling variants of the name — vary first name AND last name; include common homophones (Bert/Burt/Bart/Bret/Brett, Shannon/Shanahan/Sheehan/Channon/Cannon/Hannon)"],
  "company": "company they work at, if mentioned",
  "roleContext": "1-line description of their role/focus (backoffice automation, AI implementation, etc.), if mentioned"
}

Rules:
- If no name is in the brief, return {"name": ""}.
- Variants must be DIFFERENT NAMES — do NOT repeat the same name with capitalisation changes.
- Include the original name in variants.
- Keep variants as "First Last" strings.
- Return ONLY the JSON object.`,
      brief,
      { maxTokens: 500, userId, userKeys },
    );
    if (!out || typeof out.name !== "string" || !out.name.trim()) return null;
    return {
      name: out.name.trim(),
      variants: Array.isArray(out.variants) ? out.variants.filter((v): v is string => typeof v === "string") : [],
      company: typeof out.company === "string" ? out.company.trim() : undefined,
      roleContext: typeof out.roleContext === "string" ? out.roleContext.trim() : undefined,
    };
  } catch (e) {
    console.warn("[name-lookup] extractNameBrief failed:", (e as Error).message);
    return null;
  }
}

function uniqueNames(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const t = s.trim();
    if (!t) continue;
    const k = t.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.slice(0, 12);
}

/** Normalized Levenshtein distance against the closest variant. */
function bestNameSimilarity(candidate: string, variants: string[]): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
  const c = norm(candidate);
  let best = Infinity;
  for (const v of variants) {
    const d = levenshtein(norm(v), c);
    if (d < best) best = d;
  }
  return best === Infinity ? 99 : best;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let curr = i;
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      curr = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(diag, prev[j], curr);
      diag = temp;
      prev[j] = curr;
    }
  }
  return prev[b.length];
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

/** True when the brief clearly names a specific person we should identify
 *  (first+last name plus "find/identify/who is/named ..." phrasing). These
 *  are 1-person lookups — bypass the count/targeting clarify loop. */
function looksLikeSpecificPersonLookup(s: string): boolean {
  if (!/\b[A-Z][a-z]+\s+[A-Z][a-zA-Z]+\b/.test(s)) return false;
  const hay = s.toLowerCase();
  return /(find|identify|locate|who\s+is|looking\s+for|search\s+for|look\s+up|someone\s+(?:named|called)|person\s+(?:named|called)|name(?:d)?\s+(?:like|similar\s+to)|similar\s+to)/.test(hay);
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
