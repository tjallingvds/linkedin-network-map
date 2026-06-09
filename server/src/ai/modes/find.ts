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
import type { AiProvider, Company, CompletionResult, Prospect, ProspectSignal } from "@app/shared";
import { env } from "../../env.js";
import { aiJson } from "../json.js";
import {
  tavilySearch, type TavilyResult,
  isTavilyQuotaError, isTavilyAuthError,
  hasTavilyKey, TavilyKeyMissingError, WebSearchFailedError,
} from "../tavily.js";
import type { UserKeys } from "../user-keys.js";
import { looksLikeCrmRead, runCrmRead } from "./crm-read.js";
import { looksLikeDecisionMakerMap, runDecisionMakers } from "./decision-makers.js";
import { looksLikePersonBackground, runPersonBackground } from "./person-background.js";
import { looksLikeSiteScrape, runSiteScraper } from "./site-scraper.js";

export interface PriorMessage { role: "user" | "assistant"; content: string }

interface Candidate {
  name: string;
  title: string;
  company: string;
  linkedin?: string;
  evidence?: string;
  confidence: "high" | "medium" | "low";
  source?: string;
  /** Prior employers surfaced from the snippet. Only populated for past-
   *  employment intents so we can verify the candidate actually worked at
   *  a target firm before filtering. */
  pastCompanies?: string[];
}

interface ParsedBrief {
  firms: string[];
  titles: string[];
  excludeFirms: string[];
  excludeTitles: string[];
  excludeSeniority: string[];
  /** Positive seniority floor — free-text descriptor like "Managing Director
   *  or above", "Partner-level", "C-suite only". Set when the brief specifies
   *  a minimum seniority ("MD+", "MD or above", "VP and up", "C-suite only").
   *  Drives query bias, extractor floor rule, and the seniority gate. Kept
   *  as free text (not an enum) so the LLM does the semantic compare against
   *  candidate titles — different firms ladder differently and a hardcoded
   *  enum would mis-classify roles like "Partner" (= MD-equivalent at a PE
   *  firm but ≠ MD at a Big-4). */
  seniorityFloor: string | null;
  geography: string[];
  context: string;
  /** Named role archetypes from the brief, each a short paragraph describing
   *  a qualifying role pattern. Preserving these separately is the only way
   *  the extractor can distinguish e.g. "Head of Technology Investment
   *  Banking" = tech-sector M&A banker (anti-pattern) from "Head of Banking
   *  Technology" = tech-for-IB-division (archetype match). */
  archetypes: string[];
  /** Explicit exclusion patterns copied verbatim from the brief, e.g.
   *  "Head of Technology IB where Technology means the sector being covered
   *  (tech-sector coverage banker, not an AI implementer)". */
  antiPatterns: string[];
  /** Employment-tense intent. "current" = target firms are the person's
   *  current employer (default). "past" = target firms are somewhere in
   *  the person's past experience AND they're no longer there (e.g.
   *  "find people who USED TO work at Celonis / UiPath"). */
  employmentIntent: "current" | "past";
  /** Firms the person must have worked at in the past (only populated
   *  when employmentIntent = "past"). When set, the target-firm filter
   *  matches PAST experience and the "not currently there" check runs. */
  pastFirms: string[];
  /** True ONLY when the brief explicitly wants people EMPLOYED AT AI-product
   *  companies — model labs, AI agent/tooling vendors (e.g. "find AI
   *  researchers at OpenAI and Anthropic"). Normally false: an ICP for
   *  selling agentic-AI services targets BUYERS (operating companies in the
   *  target industries), so AI vendors are competitors. When false and the
   *  brief is archetype-driven, the company-type gate drops vendor employers
   *  so a bare "Head of AI" query can't surface a model-lab exec. */
  targetsAiVendors: boolean;
}

/** How strictly the archetype gate matches the brief's role archetypes.
 *  "strict" = only the exact archetypes as written; "broad" = treat them as
 *  examples and accept adjacent/sibling senior roles in the same function
 *  family (the user's per-search toggle). */
export type MatchBreadth = "strict" | "broad";

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
  matchBreadth: MatchBreadth = "broad",
): Promise<CompletionResult> {
  assertKeys(provider, userKeys);

  const priorUserText = priorMessages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
  const fullBrief = priorUserText ? `${priorUserText}\n${userInput}` : userInput;

  // ── CRM-read fast path ──────────────────────────────────────────────────
  // "what's in my Banks board?" / "list the technical people in my CRM" /
  // "summarise my outreach pipeline". Pulls structured data straight from
  // the user's own boards — no Tavily, no web inference. Runs FIRST so a
  // possessive reference ("my CRM") doesn't get hijacked by site-scrape
  // (URL detection), person-background ("what do you know"), or the
  // generic find pipeline (which would try to web-search the board name).
  if (looksLikeCrmRead(fullBrief)) {
    const cr = await runCrmRead({ provider, brief: fullBrief, userId, userKeys });
    if (cr) return cr;
    // Fall through if parsing failed — better to attempt the generic
    // pipeline than return an unhelpful "couldn't parse" message.
  }

  // ── Site-scraper fast path ──────────────────────────────────────────────
  // "scrape acme.com" / "crawl https://… and tell me everything" — fetch
  // the site (bounded crawl) and synthesise a structured brief. Runs first
  // because a URL in the brief is a strong signal that overrides the
  // person/people branches.
  if (looksLikeSiteScrape(fullBrief)) {
    const scrape = await runSiteScraper({ provider, brief: fullBrief, userId, userKeys });
    if (scrape) return scrape;
  }

  // ── Person-background fast path ─────────────────────────────────────────
  // "Tell me everything about Francois Buet-Golfouse at Barclays" — pull
  // non-obvious colour (posts, talks, papers, interviews) with citations.
  // Checked BEFORE decision-makers + name-lookup because those two would
  // respectively try to map a buying committee or return a ranked "who is
  // this?" list, neither of which is what the user asked for.
  if (looksLikePersonBackground(fullBrief)) {
    const bg = await runPersonBackground({ provider, brief: fullBrief, userId, userKeys });
    if (bg) return bg;
    // Fall through only if target extraction failed (pronoun with no
    // antecedent anywhere in the conversation).
  }

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

  // "all / everyone / every" with no explicit number means "a big list,
  // pick a sensible default" — NOT count=1. Past regression: clarify LLM
  // was returning {ready:true, count:1} for "find me all people at X" and
  // the user got a single prospect back. Default to 50 and skip clarify.
  // Note: do NOT treat "the people" as an implicit "many" — it's a neutral
  // phrasing ("find the people implementing AI") that should still go
  // through clarify and ask for a count, not silently default to 50.
  const saysAll = /\b(?:all|every(?:one|body)?|each)\s+(?:of\s+the\s+)?(?:people|person|employees|contacts|prospects|staff|folks)?\b/i.test(fullBrief);
  if (saysAll && !requestedCount) {
    requestedCount = 50;
  }

  if ((!requestedCount || !hasTargeting) && !isNameLookup) {
    try {
      // When targeting is already present (a role/company/industry brief or a
      // full pasted ICP), the ONLY thing that can be missing is the count.
      // Tell the LLM so it stops replying "what targeting do you need?" to a
      // fully-specified ICP — the exact loop users hit when re-pasting their
      // ICP without a number.
      const targetingNote = hasTargeting
        ? "TARGETING IS ALREADY PRESENT in this brief (roles, companies, industry, or a full ICP are specified). Do NOT ask what to target and do NOT ask the user to clarify their ICP — the ONLY thing you may be missing is the COUNT. "
        : "";
      const clarify = await aiJson<{ ready: boolean; question?: string; count?: number }>(
        provider,
        "You screen a prospecting brief before running a web search. " +
        targetingNote +
        "Require (a) some targeting (role/seniority/industry/company/region) AND (b) a specific COUNT of how many prospects the user wants. " +
        "If a count is missing, return {\"ready\": false, \"question\": \"How many would you like? e.g. 25, 50, 100, 200.\"} — do NOT invent a count and do NOT return ready:true without an integer count. " +
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
    // Hard guard — if clarify returned {ready:true} without a valid count
    // (LLM decided the user "obviously wants many" and skipped emitting a
    // number), do NOT silently default to 8. Ask. Bug repro: "find the
    // people implementing AI at tier-2 and tier-3 banks" → LLM returns
    // ready:true with no count → code fell through to targetCount=8 → user
    // got 2 prospects back.
    if (!requestedCount) {
      return { kind: "text", content: "How many prospects would you like? e.g. 25, 50, 100, 200." };
    }
  }
  const targetCount = Math.min(Math.max(requestedCount || 8, 1), 200);

  // ── Legacy: parse brief → build extractCtx ────────────────────────────────
  const parsed = await parseBrief(provider, fullBrief, userId, userKeys);
  // Surface the extracted targeting so a "why did it ignore the company I
  // named?" report can be diagnosed from the logs — an empty firms[] when
  // the brief clearly named one is the tell that extraction misread it.
  console.log(`[find] parsed brief → firms=[${(parsed?.firms ?? []).join(", ")}] titles=[${(parsed?.titles ?? []).join(", ")}] floor=${parsed?.seniorityFloor ?? "none"}`);

  // HARD CEILING on total Tavily calls for this entire find request, across
  // firm-discovery AND all people-search rounds. ~2 credits/call, so 50 ≈ 100
  // credits — a firm upper bound regardless of target/rounds. Declared here
  // (not inside the loop) so the firm-discovery stage below draws from the
  // same shared budget and can never run away with credits.
  const searchBudget = { remaining: 50 };

  // ── Company-list output ──────────────────────────────────────────────────
  // The user asked for COMPANIES (a target-account list), not people. Run the
  // same hybrid firm-discovery, but PROFILE the firms and return them as the
  // result instead of pivoting to a people-search at them. Intent resolution:
  // the latest message wins — an explicit people request overrides company
  // intent inherited from earlier turns; a bare answer (e.g. the count "50")
  // inherits the company intent from history.
  const wantsCompanies = looksLikePeopleRequest(userInput)
    ? false
    : looksLikeCompanySearch(userInput) || looksLikeCompanySearch(fullBrief);
  if (parsed && wantsCompanies && !isNameLookup) {
    let names: string[] = [];
    try {
      names = await discoverFirms({
        provider, parsed, brief: fullBrief, userId, userKeys, searchBudget, count: targetCount,
      });
    } catch (e) {
      // Quota/auth/missing-key surface as a clear card; any other discovery
      // failure is non-fatal — fall back to the firms the user named so the
      // whole request never dies on one bad sub-call.
      if (isTavilyQuotaError(e) || isTavilyAuthError(e) || e instanceof TavilyKeyMissingError) throw e;
      console.warn("[find] company discovery failed, falling back to named firms:", (e as Error).message);
    }
    // Fold in any firms the user already named — they qualify by definition.
    const allNames: string[] = [];
    const seen = new Set<string>();
    for (const n of [...parsed.firms, ...names]) {
      const key = n.toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      allNames.push(n);
    }
    if (allNames.length === 0) {
      return {
        kind: "text",
        content: "I couldn't surface companies matching that ICP — try loosening a hard constraint (e.g. the employee floor or a specific sub-industry) and ask again.",
      };
    }
    const companies = await profileCompanies({
      provider, names: allNames.slice(0, targetCount), brief: fullBrief, userId, userKeys,
    });
    const summary = `Found ${companies.length} compan${companies.length === 1 ? "y" : "ies"} matching your ICP. Each was checked against your full criteria — not just industry — and filtered to buyers (no vendors/competitors).`;
    return { kind: "companies", summary, companies };
  }

  // ── Firm discovery ───────────────────────────────────────────────────────
  // The query generator is firm-anchored — it only searches firms the brief
  // names. When the user describes a company TYPE by characteristics (or asks
  // for "more / adjacent companies") rather than naming firms, expand to a
  // vetted set of qualifying BUYER firms so the people-search has real anchors
  // instead of free-associating into whoever is most famous for the title
  // (which is how competitors surfaced). Hybrid: the LLM names firms from
  // world knowledge AND Tavily runs its own firm-finding queries; the merged
  // list is filtered to buyers (no AI vendors/competitors). Always on UNLESS
  // the user explicitly locked the search to the firms they named ("only at
  // X"). Skipped for name-lookups, past-employment briefs (firms live in
  // pastFirms), and briefs explicitly targeting AI-vendor employees.
  if (
    parsed &&
    !isNameLookup &&
    parsed.employmentIntent !== "past" &&
    !parsed.targetsAiVendors &&
    !(looksLockedToNamedFirms(fullBrief) && parsed.firms.length > 0)
  ) {
    try {
      const discovered = await discoverFirms({ provider, parsed, brief: fullBrief, userId, userKeys, searchBudget });
      if (discovered.length > 0) {
        const seen = new Set(parsed.firms.map((f) => f.toLowerCase().trim()));
        const additions = discovered.filter((f) => !seen.has(f.toLowerCase().trim()));
        // Cap the anchored firm set so query generation stays focused and the
        // remaining search budget isn't spread impossibly thin.
        parsed.firms = [...parsed.firms, ...additions].slice(0, 40);
        console.log(`[find] firm set after discovery (${parsed.firms.length}): ${parsed.firms.slice(0, 30).join(", ")}`);
      }
    } catch (e) {
      // Quota/auth errors must surface so the user sees a clear card; other
      // discovery failures are non-fatal — fall through to the named firms.
      if (isTavilyQuotaError(e) || isTavilyAuthError(e) || e instanceof TavilyKeyMissingError) throw e;
      console.warn("[find] firm discovery failed, continuing with named firms:", (e as Error).message);
    }
  }

  const extractCtx = buildExtractCtx(parsed);

  // ── Legacy: multi-round discover loop ────────────────────────────────────
  const allPeople: Candidate[] = [];
  // Candidates dropped by the archetype gate across all rounds, deduped by
  // name. If the gate rejects the entire pool we fall back to surfacing
  // these as low-confidence "best-effort" results so the user can judge for
  // themselves rather than seeing a useless "Found 0".
  const allRejectedByArchetype: Candidate[] = [];
  const rejectedSeen = new Set<string>();
  // Same pattern as rejectedByArchetype: accumulate seniority-gate rejects
  // across rounds (deduped by name) so the diagnostic can call them out
  // and so we can fall back to surfacing them when the gate killed the
  // entire pool.
  const allRejectedBySeniority: Candidate[] = [];
  const rejectedSenioritySeen = new Set<string>();
  const seenNames = new Set<string>();
  const funnelTotals: FunnelStats = {
    extracted: 0, afterClean: 0, afterBriefFilter: 0,
    afterConfidence: 0, afterSeniorityGate: 0, afterArchetypeGate: 0, excludedAsAlreadyShown: 0,
  };
  // Pre-seed with names already shown earlier in this chat so cross-turn
  // dedup works. Without this, turn 3 ("find everyone at JPM/Barclays/…")
  // happily returned people turn 1 ("find everyone at Goldman Sachs")
  // already surfaced — which the user saw and called out.
  for (const n of alreadyShownNames) {
    const key = n.toLowerCase().trim();
    if (key) seenNames.add(key);
  }
  // Keep digging across rounds until one of three things is true:
  //   1. we've found at least HALF of what the user asked for (a satisfying
  //      floor — niche briefs rarely yield 100% of a big ask),
  //   2. we've spent the ~2-minute time budget, or
  //   3. the web is exhausted (a round surfaces zero NEW people — only dupes).
  // MAX_ROUNDS is just a backstop; time/exhaustion are the real limits. The
  // old policy stopped after 3 rounds or as soon as it had 30% of the ask,
  // which is why a 200-person brief gave up at a handful.
  //
  // The search runs in a BACKGROUND JOB now (chats.ts), not on the HTTP
  // request, so it's no longer bound by the platform's ~60-90s request cap —
  // we can dig for the full budget without the socket being reset. The client
  // polls a status endpoint, so a long run just means more polls, not a
  // "Failed to fetch".
  const SEARCH_TIME_BUDGET_MS = 120_000;
  const halfTarget = Math.ceil(targetCount / 2);
  const searchStartedAt = Date.now();
  const MAX_ROUNDS = 12;
  // searchBudget is declared above (shared with the firm-discovery stage) so
  // discovery + all people-search rounds draw from one ceiling.

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const remaining = targetCount - allPeople.length;
    if (remaining <= 0) break;
    // Stop conditions are checked at the START of each round (after round 0,
    // which always runs): an in-flight round is always allowed to finish.
    if (round > 0) {
      if (searchBudget.remaining <= 0) {
        console.log(`[find] search budget exhausted (${allPeople.length}/${targetCount}) — stopping`);
        break;
      }
      if (allPeople.length >= halfTarget) {
        console.log(`[find] reached half-target (${allPeople.length}/${targetCount}) — stopping`);
        break;
      }
      const elapsed = Date.now() - searchStartedAt;
      if (elapsed >= SEARCH_TIME_BUDGET_MS) {
        console.log(`[find] time budget spent (${Math.round(elapsed / 1000)}s, ${allPeople.length}/${targetCount}) — stopping`);
        break;
      }
    }

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

    let roundResult: HandleDiscoveryResult;
    try {
      roundResult = await handleDiscovery({
        provider,
        query: roundQuery,
        targetCount: remaining,
        extractionHint: extractCtx,
        parsed,
        userId,
        userKeys,
        matchBreadth,
        searchBudget,
      });
    } catch (e) {
      // A web-search failure / credit error on a LATER round must not nuke
      // the people earlier rounds already found — returning a partial list
      // beats erroring out the whole request. Only let it propagate (to the
      // friendly chat card) when we have nothing to show yet.
      if (
        (isTavilyQuotaError(e) || isTavilyAuthError(e) ||
          e instanceof TavilyKeyMissingError || e instanceof WebSearchFailedError) &&
        allPeople.length > 0
      ) {
        console.warn(`[find] round ${round + 1} web-search error, keeping ${allPeople.length} prior results: ${(e as Error).message}`);
        break;
      }
      throw e;
    }
    const { people: roundPeople, funnel: roundFunnel, rejectedByArchetype, rejectedBySeniority } = roundResult;
    // Accumulate rejected candidates with name-level dedup so the fallback
    // pool doesn't grow with duplicate entries across rounds.
    for (const r of rejectedByArchetype) {
      const key = (r.name || "").toLowerCase().trim();
      if (!key || rejectedSeen.has(key)) continue;
      rejectedSeen.add(key);
      allRejectedByArchetype.push(r);
    }
    for (const r of rejectedBySeniority) {
      const key = (r.name || "").toLowerCase().trim();
      if (!key || rejectedSenioritySeen.has(key)) continue;
      rejectedSenioritySeen.add(key);
      allRejectedBySeniority.push(r);
    }
    // Aggregate across rounds so the empty-result diagnostic can point at
    // which stage actually nuked the pool (extraction / brief filter /
    // archetype gate). Without this, "0 results" gives the user no
    // actionable signal — they get told to "try a more specific brief"
    // even when their brief was already overspecified.
    funnelTotals.extracted += roundFunnel.extracted;
    funnelTotals.afterClean += roundFunnel.afterClean;
    funnelTotals.afterBriefFilter += roundFunnel.afterBriefFilter;
    funnelTotals.afterConfidence += roundFunnel.afterConfidence;
    funnelTotals.afterSeniorityGate += roundFunnel.afterSeniorityGate;
    funnelTotals.afterArchetypeGate += roundFunnel.afterArchetypeGate;

    if (roundPeople.length === 0) break;

    let newCount = 0;
    for (const p of roundPeople) {
      const key = (p.name || "").toLowerCase().trim();
      if (key && !seenNames.has(key)) {
        seenNames.add(key);
        allPeople.push(p);
        newCount++;
      } else if (key) {
        // Candidate passed all the filters but was deduped against either
        // the user's CRM or an earlier chat turn. Count it so the summary
        // can say "30 hits but all already in your CRM" instead of a
        // misleading "0 results".
        funnelTotals.excludedAsAlreadyShown++;
      }
    }

    console.log(`[find] round ${round + 1}: ${roundPeople.length} raw, ${newCount} new (total ${allPeople.length}/${targetCount})`);

    // Only stop early when a round adds ZERO new people — that means the
    // query generator + Tavily are returning pure dupes, so the web is
    // exhausted for this brief and more rounds won't help. Otherwise keep
    // digging toward the half-target / time budget checked at the top of the
    // loop. (The old "stop once you have 30% and a round added <3" break is
    // gone — that's what made big briefs give up early.)
    if (newCount === 0) break;
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

  // Archetype-gate rescue. When the gate rejected EVERY candidate, returning
  // "Found 0" leaves the user nothing to act on — yet they often want to
  // see the rejected pool to judge whether the gate was wrong or the brief
  // was wrong. Surface them as low-confidence prospects with a clear
  // "may not match the brief" warning baked into the summary AND each
  // card's signals (the rejection reason was attached upstream).
  if (prospects.length === 0 && allRejectedByArchetype.length > 0) {
    const fallback = allRejectedByArchetype.slice(0, targetCount).map((c, i) => {
      const signals: ProspectSignal[] = [
        { kind: "match", text: "⚠ Likely mismatch — flagged by archetype gate", when: "" },
      ];
      if (c.evidence) signals.push({ kind: "match", text: c.evidence, when: "" });
      return {
        id: `p${Date.now()}-rej-${i}`,
        name: c.name,
        title: c.title,
        company: c.company,
        linkedin: normalizeLinkedInUrl(c.linkedin),
        signals,
        past: [],
        matchPct: 50,
      };
    });
    const summary =
      `Found 0 strict matches. Showing ${fallback.length} ` +
      `${fallback.length === 1 ? "candidate" : "candidates"} that fit the firm/title filter ` +
      `but the archetype gate flagged as potentially off-brief — review them yourself. ` +
      `If most look right, your archetype is too narrow (e.g. one seniority level or one division ` +
      `when the role spans several at these firms); if most look wrong, your brief is doing its job.`;
    return { kind: "prospects", summary, prospects: fallback };
  }

  const summary = composeFindSummary(prospects.length, targetCount, funnelTotals, parsed);

  return { kind: "prospects", summary, prospects };
}

/** Build a result summary that points the user at the actionable cause
 *  when the funnel produced few/zero matches. Without this, "0 results"
 *  always told the user to "try a more specific brief", which is
 *  exactly the wrong advice when the brief was over-specified to begin
 *  with — the user's "SVPs only, not Chief / Head" brief had narrow
 *  exclude-titles dropping every Tavily hit, and they had no signal as
 *  to which constraint was the problem. */
function composeFindSummary(
  found: number,
  target: number,
  f: FunnelStats,
  parsed: ParsedBrief | null,
): string {
  if (found >= target) return `Found ${found} matching prospects.`;
  if (found > 0) {
    // Surface the funnel even on partial results so the user knows
    // WHICH constraint thinned the pool. Previously a "Found 2 of 100"
    // result told the user nothing actionable.
    const parts: string[] = [];
    if (f.excludedAsAlreadyShown > 0) parts.push(`${f.excludedAsAlreadyShown} already in your CRM/chat`);
    const briefDrop = f.afterClean - f.afterBriefFilter;
    if (briefDrop > 0 && briefDrop >= f.afterClean / 2) {
      const ex = (parsed?.excludeTitles ?? []).slice(0, 3).join(", ");
      parts.push(`${briefDrop} dropped by exclude-titles${ex ? `: ${ex}` : ""}/firm filter`);
    }
    const seniorityDrop = f.afterConfidence - f.afterSeniorityGate;
    if (seniorityDrop > 0 && seniorityDrop >= f.afterConfidence / 2 && parsed?.seniorityFloor) {
      parts.push(`${seniorityDrop} below seniority floor "${parsed.seniorityFloor}"`);
    }
    const archetypeDrop = f.afterSeniorityGate - f.afterArchetypeGate;
    if (archetypeDrop > 0 && archetypeDrop >= f.afterSeniorityGate / 2) {
      parts.push(`${archetypeDrop} rejected by archetype gate`);
    }
    const detail = parts.length ? ` — ${parts.join(", ")}` : "";
    return `Found ${found} (couldn't surface ${target})${detail}. Broaden the brief or try "find more" for another pass.`;
  }
  // found === 0. Special case: the search WAS productive, but every hit
  // collided with the user's CRM or prior turns. That's a very different
  // root cause from "filters were too tight" and deserves its own message.
  if (f.excludedAsAlreadyShown > 0 && f.excludedAsAlreadyShown >= f.afterArchetypeGate) {
    return `Found 0 new prospects — the search returned ${f.excludedAsAlreadyShown} matches but they were all already in your CRM or this chat. Either the niche is exhausted for the roles you've targeted, or relax the brief (e.g. add adjacent firms or broader titles).`;
  }
  // Diagnose by the largest drop in the funnel.
  if (f.extracted === 0) {
    return `Found 0 — the web search returned nothing usable for these firms+titles. The firms may be too obscure, or the title combination too rare. Try broader role keywords or check the firm names.`;
  }
  if (f.afterBriefFilter === 0 && f.afterClean > 0) {
    const ex = parsed?.excludeTitles ?? [];
    const exMsg = ex.length ? ` (exclude-titles: ${ex.slice(0, 3).join(", ")})` : "";
    return `Found 0 — extracted ${f.afterClean} candidates but the brief filter dropped them all${exMsg}. The exclude-titles or target-firm constraints are too tight for the snippets the web returned. Try relaxing the title constraint.`;
  }
  if (f.afterSeniorityGate === 0 && f.afterConfidence > 0 && parsed?.seniorityFloor) {
    return `Found 0 — extracted ${f.afterConfidence} candidates that fit the firm/title filter, but the seniority gate dropped them all as below "${parsed.seniorityFloor}". The web snippets are returning more junior people than the floor allows. Either lower the floor (e.g. "Director or above" instead of "MD or above") or broaden the firm list — niche firms often don't have many at-or-above-MD profiles indexed by Tavily.`;
  }
  if (f.afterArchetypeGate === 0 && f.afterSeniorityGate > 0) {
    return `Found 0 — extracted ${f.afterSeniorityGate} candidates that cleared the seniority floor, but the archetype gate rejected them all as not matching the role you described. Either the snippets didn't have enough role context, or your archetype is too narrow (e.g. a single division when the role exists across several at these firms). Try relaxing the scope constraint and retry.`;
  }
  if (f.afterConfidence === 0 && f.afterBriefFilter > 0) {
    return `Found 0 — ${f.afterBriefFilter} candidates passed the firm/title filter but none scored above low-confidence. Web snippets weren't specific enough; try adding a sector or location to the brief.`;
  }
  return `Found 0 — extracted ${f.extracted}, lost most through filters (clean ${f.afterClean} → brief ${f.afterBriefFilter} → confidence ${f.afterConfidence} → seniority ${f.afterSeniorityGate} → archetype ${f.afterArchetypeGate}). Relax one constraint at a time and retry.`;
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
  "firms": ["<exact company name from brief>", ...],
  "titles": ["<short title keyword>", ...],
  "excludeFirms": ["<exact company name to exclude>", ...],
  "excludeTitles": ["<title pattern to exclude>", ...],
  "excludeSeniority": ["<level to exclude>", ...],
  "seniorityFloor": "<one-line description of the minimum seniority bar, or null>",
  "geography": ["<region/country>", ...],
  "context": "2-4 sentence summary of what KIND of person qualifies — role semantics, not just titles",
  "archetypes": ["<role archetype as named in brief>", ...],
  "antiPatterns": ["<exclusion rule as worded in brief>", ...],
  "employmentIntent": "current" | "past",
  "pastFirms": ["<exact company name>", ...],
  "targetsAiVendors": false
}

Rules:
- Extract EXACT company names mentioned as targets. Do not add companies not named in the brief.
- COMPANY NAMES CAN BE ORDINARY WORDS. Many real companies are spelled as common English words or adjectives — Wise, Stripe, Block, Brex, Ramp, Monzo, Revolut, Apple, Meta, Mercury, Plaid, Notion, Linear, Figma. When the brief references such a word as an organisation, extract it as a firm even when it is lowercase or reads like an adjective. Signals that a word is the target COMPANY (not a description): it follows "at", "from", "@", "with"; it is possessive ("X's head of…"); or it sits directly before a role noun ("the X Head of Y", "X CTO"). Example: "who is the wise Head of TGS" → firms: ["Wise"] (Wise is the fintech, NOT the adjective "wise"). Example: "find the block VP of risk" → firms: ["Block"].
- WHO-IS / SINGLE-TARGET QUESTIONS: a question like "who is the <role> at <Company>" or "who runs <function> at <Company>" names exactly one target firm — always populate "firms" with that company. Never return empty firms when a company is identifiable in the brief.
- titles = SHORT searchable keywords (≤4 words each), not verbose verbatim titles. Keep unfamiliar acronyms or internal team names (e.g. "TGS") verbatim in titles — do NOT expand them into guesses like "AI" or "Technology"; if you genuinely cannot tell what a role token means, keep it as-is rather than substituting a broader function.
- archetypes: if the brief numbers or names role categories (e.g. "1. <archetype name>", "Archetype 2: <archetype name>"), capture each as a separate entry WITH its disambiguation rules and exclusions. When the brief is a long ICP/company description rather than a role list, derive archetypes from the PERSON the user actually wants to reach — e.g. a bullet like "they have hired a Head of AI / Enterprise Head of AI / Head of AI Transformation" means the archetypes are those job titles. Do NOT leave archetypes empty just because the doc is prose.
- antiPatterns: capture ONLY explicit PERSON/ROLE-level exclusions — clauses that tell you which kind of PERSON to reject ("exclude RPA developers", "no sales reps", "not customer-facing roles", "avoid junior engineers"). A valid anti-pattern names a role/job-family to drop.
  - DO NOT turn descriptions of the TARGET COMPANY, the market situation, the deal, or the NATURE OF THE WORK into anti-patterns. These describe the account, not a person to exclude, and a downstream per-candidate gate will wrongly reject everyone if you do.
  - Negative example: a brief line "Not RPA: judgment-based workflows that deterministic bots can't handle" describes the WORK the product targets — it is NOT an instruction to reject people. Do NOT emit "Not RPA" (or "beyond point solutions", "not legacy", "regulated", "ops-heavy", etc.) as an anti-pattern.
  - When in doubt whether a clause excludes a PERSON vs. describes the ACCOUNT, leave it out. An over-eager anti-pattern is far more damaging than a missing one.
- seniorityFloor: set this WHENEVER the brief states a minimum seniority bar — even casually. Trigger phrases include: "MD or above", "MD+", "MD and up", "Director-level or higher", "Partner level", "C-suite only", "VP and above", "Head-of and up", "senior leadership", "executives only", "decision-makers", "no juniors", "no analysts/associates", "top brass". Write the floor as one short phrase that names the minimum acceptable level AND makes "or above" explicit, e.g. "Managing Director or above", "Partner-level or above", "C-suite (CXO/Chief) only", "Head of <function> or above". If no minimum bar is stated, return null. Do NOT invent a floor that the brief didn't ask for.
- excludeSeniority is for EXCLUSIONS only ("not VPs", "no Directors") — not for floors. When a floor is set, leave excludeSeniority empty unless the brief separately calls out a level to exclude. The seniorityFloor field drives a downstream semantic gate that handles "or above" semantics correctly across firm-specific title ladders.
- employmentIntent: set to "past" when the brief clearly asks for people who USED TO work at the target firms and are no longer there. Trigger phrases: "ex-", "former", "formerly at", "used to work at", "previously at", "have left", "alumni of", "recent leavers from", "departed X". Default to "current" otherwise.
- pastFirms: when employmentIntent = "past", move the target firms to pastFirms AND leave "firms" EMPTY (so current-employer filters pass through). The extractor will then filter on past experience. When employmentIntent = "current", leave pastFirms empty.
- Include all variant spellings of an excluded firm if the brief gives them (e.g. an abbreviation alongside the full name).
- If the brief lists no archetypes or anti-patterns, return empty arrays. Do not invent any.
- targetsAiVendors: default false. Set true ONLY when the brief EXPLICITLY wants people who WORK AT AI-product companies — foundation-model labs or AI agent/tooling vendors (e.g. "find AI researchers at OpenAI and Anthropic", "engineers at foundation-model labs", "leaders at AI startups"). When the brief describes selling/deploying AI INTO customer organisations (an ICP whose targets are operating companies — banks, insurers, payments, retail, etc.), leave it false: people employed at AI vendors are competitors, not prospects.

Return ONLY the JSON object.`,
      brief,
      { maxTokens: 3000, userId, userKeys },
    );
    const employmentIntent: "current" | "past" = parsed.employmentIntent === "past" ? "past" : "current";
    return {
      firms: parsed.firms ?? [],
      titles: parsed.titles ?? [],
      excludeFirms: parsed.excludeFirms ?? [],
      excludeTitles: parsed.excludeTitles ?? [],
      excludeSeniority: parsed.excludeSeniority ?? [],
      seniorityFloor: typeof parsed.seniorityFloor === "string" && parsed.seniorityFloor.trim()
        ? parsed.seniorityFloor.trim()
        : null,
      geography: parsed.geography ?? [],
      context: parsed.context ?? "",
      archetypes: Array.isArray(parsed.archetypes) ? parsed.archetypes.filter((a): a is string => typeof a === "string") : [],
      antiPatterns: Array.isArray(parsed.antiPatterns) ? parsed.antiPatterns.filter((a): a is string => typeof a === "string") : [],
      employmentIntent,
      pastFirms: Array.isArray(parsed.pastFirms) ? parsed.pastFirms.filter((a): a is string => typeof a === "string") : [],
      targetsAiVendors: parsed.targetsAiVendors === true,
    };
  } catch (e) {
    console.warn("parseBrief failed:", (e as Error).message);
    return null;
  }
}

/** Matches legacy chat-discovery.js: `extractCtx` built only when firms exist.
 *  Extended to carry the brief's role archetypes and anti-patterns forward
 *  to the extractor. Without these, the extractor sees only flat title
 *  keywords and accepts look-alike roles (e.g. "Head of Technology IB" as
 *  a tech-sector coverage MD when the brief wanted tech-for-IB-division). */
function buildExtractCtx(parsed: ParsedBrief | null): string {
  if (!parsed) return "";
  const hasCurrentTargets = parsed.firms.length > 0;
  const hasPastTargets = parsed.employmentIntent === "past" && parsed.pastFirms.length > 0;
  const hasFloor = !!parsed.seniorityFloor;
  // Build context whenever ANY structured filter is set — including a bare
  // seniority floor with no firms (e.g. "find me C-suite execs in fintech").
  // Without this, a brief that specifies a floor but no target firms would
  // skip the extractor's seniority rule entirely.
  if (!hasCurrentTargets && !hasPastTargets && !hasFloor) return "";
  let ctx = "";
  if (parsed.context) ctx += `LOOKING FOR: ${parsed.context}\n`;
  if (hasFloor) {
    ctx += `\nSENIORITY FLOOR — minimum acceptable seniority: ${parsed.seniorityFloor}\n` +
      `  • Reject any candidate whose title is clearly BELOW this bar.\n` +
      `  • Different firms ladder differently — judge semantically, not by keyword. Examples (firm-dependent):\n` +
      `      - "Partner" at a PE/consulting/law firm ≈ MD-equivalent. ACCEPT for an "MD or above" floor.\n` +
      `      - "EVP" at a US bank can sit ABOVE MD; at a European bank it often sits BELOW. Use evidence.\n` +
      `      - "Head of <function>" can be MD-level or VP-level — accept only when evidence implies the bar.\n` +
      `  • If genuinely ambiguous (bare "Director" / "VP" with no scope context), KEEP the candidate — the seniority gate downstream will adjudicate. Do not pre-filter on ambiguity.\n` +
      `  • Hard rejects for an "MD/Partner/C-suite" floor: anything titled Analyst, Associate, Senior Associate, Manager, Senior Manager, Assistant VP, Intern, Trainee, Apprentice, or any "Junior X" / "Graduate X".\n`;
  }
  if (hasPastTargets) {
    ctx += `PAST EMPLOYER TARGETS (match on PRIOR experience, NOT current employer): ${parsed.pastFirms.join(", ")}\n`;
    ctx += `INTENT: find people who USED TO work at one of these firms AND have since LEFT. The candidate's CURRENT company must NOT be one of these firms. Their LinkedIn Experience must list one of these firms in a prior role.\n`;
  }
  if (hasCurrentTargets) {
    ctx += `TARGET FIRMS (only extract people currently at these): ${parsed.firms.join(", ")}\n`;
  }
  if (parsed.titles.length) ctx += `TARGET TITLES (keywords): ${parsed.titles.join(", ")}\n`;
  if (parsed.archetypes.length) {
    ctx += `\nROLE ARCHETYPES — a candidate MUST plausibly match one of these. Match on role SEMANTICS, not just title keywords:\n`;
    for (let i = 0; i < parsed.archetypes.length; i++) {
      ctx += `  ${i + 1}. ${parsed.archetypes[i]}\n`;
    }
  }
  if (parsed.antiPatterns.length) {
    ctx += `\nANTI-PATTERNS — reject candidates matching ANY of these, even if their title keywords look like a hit:\n`;
    for (const ap of parsed.antiPatterns) {
      ctx += `  - ${ap}\n`;
    }
  }
  if (parsed.excludeFirms.length) ctx += `\nEXCLUDE firms: ${parsed.excludeFirms.join(", ")}\n`;
  if (parsed.excludeTitles.length) ctx += `EXCLUDE title patterns: ${parsed.excludeTitles.join(", ")}\n`;
  if (parsed.excludeSeniority.length) ctx += `EXCLUDE seniority: ${parsed.excludeSeniority.join(", ")}\n`;
  return ctx;
}

/** True when the brief explicitly restricts the search to the firms the user
 *  named — "only at Stripe", "just these companies", "no other firms". When
 *  set (and firms are actually named), the firm-discovery stage is skipped so
 *  the search stays anchored to exactly what the user listed. Errs toward NOT
 *  locking — discovery is the default the user asked for. */
function looksLockedToNamedFirms(brief: string): boolean {
  const hay = brief.toLowerCase();
  return (
    /\b(only|just|solely|exclusively|strictly)\b[^.\n]{0,40}\b(at|from|within|in)\b/.test(hay) ||
    /\bonly\s+(these|those|the\s+(?:following|named|listed))\b/.test(hay) ||
    /\b(no|not|never)\s+(other|additional|new)\s+(firms?|companies|orgs?|organi[sz]ations?)\b/.test(hay) ||
    /\b(don'?t|do\s*not)\s+(add|expand|include|widen|discover)\b[^.\n]{0,30}\b(firms?|companies|orgs?)\b/.test(hay)
  );
}

/** True when the latest message explicitly asks for PEOPLE — used to override
 *  a stale company-intent inherited from earlier in the conversation (e.g.
 *  "find companies …" on turn 1, then "find people at these companies" later).
 *  The newest message's intent wins. */
function looksLikePeopleRequest(text: string): boolean {
  const hay = text.toLowerCase();
  return (
    /\b(?:find|get|show|give|list|pull|surface|identify)\s+(?:me\s+)?(?:more\s+|all\s+|some\s+|\d+\s+)?(?:people|persons?|contacts?|prospects?|leads?|profiles?|names?|individuals?|executives?|employees?|staff)\b/.test(hay) ||
    /\b(?:people|contacts?|prospects?|leads?|executives?|leaders?|decision[-\s]?makers?)\s+(?:at|from|in|within|for)\b/.test(hay)
  );
}

/** True when the user is asking for a list of COMPANIES (a target-account
 *  list) rather than people. The object of the request must be firms — "find
 *  companies that fit this", "which firms match", "list accounts" — NOT a
 *  people search that merely mentions companies ("find Heads of AI at fintech
 *  companies"). Tightly anchored on the verb→noun adjacency so a normal
 *  people search is never misrouted. */
function looksLikeCompanySearch(brief: string): boolean {
  const hay = brief.toLowerCase();
  // Stem allows the common truncation "companie" (user cut "companies" short).
  const noun = "(?:compan(?:y|ies|ie)|firms?|accounts?|organi[sz]ations?|orgs?|businesses|institutions?|employers)";
  // "find / list / show / give me [the|these|those|N|all|some|more|a list of] companies …"
  // The determiner alternatives (the/these/those/that) matter: without them
  // "find these companies" / "find the companies" fell through to the PEOPLE
  // path and returned scattered individuals instead of a target-account list.
  const direct = new RegExp(`\\b(?:find|list|show|get|give|identify|surface|build\\s+(?:me\\s+)?a\\s+list\\s+of|compile|pull)\\s+(?:me\\s+)?(?:the\\s+|these\\s+|those\\s+|that\\s+|all\\s+|some\\s+|more\\s+|a\\s+list\\s+of\\s+|up\\s+to\\s+\\d+\\s+|\\d+\\s+)?${noun}\\b`);
  // "which / what companies …"
  const whichWhat = new RegExp(`\\b(?:which|what)\\s+${noun}\\b`);
  // "companies that (can) fit / match / qualify …"
  const thatFit = new RegExp(`\\b${noun}\\s+(?:that|which|who)\\s+(?:can\\s+|could\\s+|would\\s+)?(?:fit|match|qualify|meet|suit|align)`);
  return direct.test(hay) || whichWhat.test(hay) || thatFit.test(hay);
}

/** Firm-discovery stage. Given an ICP described by CHARACTERISTICS (industry,
 *  size, regulated, ops-heavy, …) rather than a fixed firm list, expand to a
 *  vetted set of qualifying BUYER companies so the people-search has real
 *  anchors instead of free-associating. Hybrid by design:
 *    1. the LLM names firms from world knowledge AND emits firm-finding web
 *       queries, then
 *    2. Tavily runs those queries (grounded, current) and names are extracted,
 *  the two lists are merged, deduped, and run through a buyer/vendor filter so
 *  no competitor ever seeds the search. Bounded by the shared search budget. */
async function discoverFirms(args: {
  provider: AiProvider;
  parsed: ParsedBrief;
  brief: string;
  userId: string;
  userKeys?: UserKeys;
  searchBudget: { remaining: number };
  /** How many firms to aim for. Defaults to 30 (the people-anchor use). The
   *  "find companies" path passes the user's requested count so the result
   *  list can reach the target. */
  count?: number;
}): Promise<string[]> {
  const { provider, parsed, brief, userId, userKeys, searchBudget } = args;
  const targetFirms = Math.max(10, Math.min(args.count ?? 30, 60));
  const namedAlready = new Set(parsed.firms.map((f) => f.toLowerCase().trim()));
  const excluded = new Set(parsed.excludeFirms.map((f) => f.toLowerCase().trim()));
  // Use the FULL ICP, not just the short parsed summary — the summary captures
  // industry + title (the "convenient" criteria) but drops the hard qualifiers
  // (employee floor, ops headcount, regulated, agentic appetite, budget,
  // less-legacy). Firm selection must honour ALL of them.
  const summary = parsed.context?.trim() || parsed.archetypes.join("; ");
  const characteristics = summary
    ? `${summary}\n\nFULL ICP (apply EVERY qualifying characteristic below, not just industry/title):\n${brief.slice(0, 4000)}`
    : brief.slice(0, 4000);

  // Step 1 — LLM proposes buyer firms AND independent web queries to find more.
  let proposed: string[] = [];
  let webQueries: string[] = [];
  try {
    const out = await aiJson<{ firms: string[]; webQueries: string[] }>(
      provider,
      `You build a target-account list for a B2B prospecting search. From the ICP below, identify real companies that FIT THE CHARACTERISTICS and would be BUYERS of the solution — organisations that would ADOPT it, operating in the target customer industries.

HARD RULE — never include VENDORS/COMPETITORS: foundation-model labs, AI agent/copilot platforms, AI developer-tooling or ML-infra companies, or AI consultancies (e.g. OpenAI, Anthropic, Cohere, Mistral, Google DeepMind, Meta AI, Microsoft AI, Databricks, Scale AI). Those SELL the solution; they are not buyers.

APPLY EVERY QUALIFYING CHARACTERISTIC, not just the convenient ones (industry + "has an AI leader"). Before including a firm, check it against ALL the ICP's hard criteria — e.g. employee floor (2,000+), operations headcount (1,000+ ops staff / genuinely ops-heavy middle/back-office), regulated environment, demonstrated pressure/appetite to adopt agentic AI, modern systems that allow API/OAuth integration ("less legacy"), and budget capacity for a six-figure contract. Exclude firms that clearly fail a hard criterion (too small, not regulated, pure-engineering/no ops weight, legacy-locked). Prefer firms you can justify against the SPECIFIC criteria, not generic "big finance brand".

Return:
- "firms": ${targetFirms} real company names that satisfy ALL the ICP's qualifying characteristics above and are BUYERS. Use exact, well-known company names. Do NOT include any company the brief already named or excluded.
- "webQueries": 4-6 web-search queries that would surface MORE such companies from the live web (e.g. "largest regulated payments companies 2024", "fintech companies over 2000 employees Europe", "insurers investing in AI operations"). These must find COMPANIES (lists, rankings, industry roundups), NOT individual people.

ICP / characteristics:
${characteristics}

Return {"firms": [...], "webQueries": [...]}.`,
      brief.slice(0, 4000),
      { maxTokens: 1500, userId, userKeys },
    );
    proposed = Array.isArray(out.firms) ? out.firms.filter((f): f is string => typeof f === "string" && f.trim().length > 1) : [];
    webQueries = Array.isArray(out.webQueries) ? out.webQueries.filter((q): q is string => typeof q === "string" && q.trim().length > 3) : [];
  } catch (e) {
    console.warn("[find] firm-discovery proposal failed:", (e as Error).message);
  }

  // Step 2 — Tavily firm-finding searches, capped so discovery never starves
  // the people-search that follows. Draws from the shared budget.
  const FIRM_DISCOVERY_CAP = Math.max(0, Math.min(5, Math.floor(searchBudget.remaining / 4)));
  const snippets: TavilyResult[] = [];
  for (const q of webQueries.slice(0, FIRM_DISCOVERY_CAP)) {
    if (searchBudget.remaining <= 0) break;
    searchBudget.remaining--;
    try {
      const r = await tavilySearch(q, { depth: "advanced", maxResults: 10, userId, userKeys });
      snippets.push(...r);
    } catch (e) {
      // Quota/auth/missing-key must propagate (so the run shows a clear card);
      // a single transient query failure is non-fatal.
      if (isTavilyQuotaError(e) || isTavilyAuthError(e) || e instanceof TavilyKeyMissingError) throw e;
      console.warn(`[find] firm-discovery query failed: "${q.slice(0, 60)}" → ${(e as Error).message}`);
    }
  }

  // Step 3 — extract buyer firm names from the web snippets.
  let fromWeb: string[] = [];
  if (snippets.length > 0) {
    try {
      const out = await aiJson<{ firms: string[] }>(
        provider,
        `From the web search results below, extract the names of real COMPANIES that match this ICP and would be BUYERS of the solution (operating companies in the target industries — NOT AI vendors / model labs / AI tooling firms, and NOT news sites, analysts, or consultancies writing about them).

ICP / characteristics:
${characteristics}

Rules:
- Only return company names that actually appear in the results below.
- Apply ALL the ICP's hard criteria (size/headcount floor, regulated, ops-heavy, etc.) — do NOT include every firm merely mentioned; include only those that plausibly qualify on the full ICP.
- Exclude AI vendors/competitors and generic publishers.
- Return up to 30 names. {"firms": [...]}`,
        buildSnippetHaystack(snippets),
        { maxTokens: 1200, userId, userKeys },
      );
      fromWeb = Array.isArray(out.firms) ? out.firms.filter((f): f is string => typeof f === "string" && f.trim().length > 1) : [];
    } catch (e) {
      console.warn("[find] firm-discovery web extraction failed:", (e as Error).message);
    }
  }

  // Merge LLM + web, dedupe (case-insensitive), drop excluded + already-named.
  const merged: string[] = [];
  const seen = new Set<string>([...namedAlready, ...excluded]);
  for (const f of [...proposed, ...fromWeb]) {
    const key = f.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(f.trim());
  }
  if (merged.length === 0) return [];

  // Step 4 — buyer/vendor backstop on the merged firm list.
  const buyers = await filterBuyerFirms({ provider, firms: merged, characteristics, userId, userKeys });
  console.log(`[find] firm-discovery: proposed=${proposed.length} web=${fromWeb.length} merged=${merged.length} → ${buyers.length} buyer firms (searchBudgetLeft=${searchBudget.remaining})`);
  return buyers.slice(0, targetFirms);
}

/** Profile a list of discovered firm NAMES into rich Company records — fit
 *  rationale + best-effort metadata — so a "find companies" search returns a
 *  usable target-account list, not bare names. World-knowledge grounded; the
 *  LLM omits fields it can't ground rather than guessing. */
async function profileCompanies(args: {
  provider: AiProvider;
  names: string[];
  brief: string;
  userId: string;
  userKeys?: UserKeys;
}): Promise<Company[]> {
  const { provider, names, brief, userId, userKeys } = args;
  if (names.length === 0) return [];
  type Profile = { name: string; industry?: string; hq?: string; employees?: string; domain?: string; linkedin?: string; fit?: string; signals?: string[] };

  // Profile in PARALLEL batches rather than one big call. A single 50-company
  // request runs ~4500 output tokens and routinely brushes the 60s per-call
  // timeout — and once the JSON-retry doubles a near-timeout call, the whole
  // company search blows past the hosting platform's request cap and the
  // socket is reset ("Failed to fetch"). Small concurrent batches keep every
  // call well under the timeout and make wall-clock ≈ one batch.
  const BATCH = 10;
  const batches: string[][] = [];
  for (let i = 0; i < names.length; i += BATCH) batches.push(names.slice(i, i + BATCH));

  const profileBatch = async (batch: string[]): Promise<Profile[]> => {
    try {
      const out = await aiJson<{ companies: Profile[] }>(
        provider,
        `For each company below, write a concise profile of how it fits this ICP. Use real-world knowledge. If you are not confident of a field, OMIT it — never guess. For employees use a band like "10,000+", not a precise number.

FULL ICP (apply EVERY qualifying characteristic, not just the convenient ones):
${brief.slice(0, 4000)}

In the "fit" sentence, address the ICP's HARD criteria — company size / headcount floor, ops-heaviness, regulated status, AI-adoption pressure, agentic risk appetite, modern systems (API/OAuth integration, "less legacy"), and budget capacity — not just the industry. If a company is included but clearly fails a hard criterion, say so honestly in "fit" (e.g. "below the 2,000-employee floor") rather than glossing over it.

For each company return: name (echo exactly), industry, hq (city/country), employees (band), domain (website), linkedin (company page URL), fit (ONE sentence grounded in the ICP's actual criteria), signals (1-3 short supporting points — e.g. a named AI leader, a public AI mandate, regulatory context, integration-readiness).

Echo the names EXACTLY as given and do NOT add companies not in the list. Return {"companies": [...]}.`,
        JSON.stringify(batch),
        { maxTokens: Math.max(1500, batch.length * 110), userId, userKeys },
      );
      return Array.isArray(out.companies) ? out.companies : [];
    } catch (e) {
      // A single batch failing just means bare names for those firms — never
      // nuke the whole list.
      console.warn(`[find] company profiling batch failed (${batch.length} firms) — bare names:`, (e as Error).message);
      return [];
    }
  };

  const batchResults = await Promise.all(batches.map(profileBatch));
  const profiles: Profile[] = batchResults.flat();
  const byName = new Map(profiles.filter((p) => typeof p?.name === "string").map((p) => [p.name.toLowerCase().trim(), p]));
  return names.map((name, i) => {
    const p = byName.get(name.toLowerCase().trim());
    const signals = Array.isArray(p?.signals) ? p!.signals.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 3) : [];
    return {
      id: `c${Date.now()}-${i}`,
      name,
      industry: typeof p?.industry === "string" && p.industry.trim() ? p.industry.trim() : undefined,
      hq: typeof p?.hq === "string" && p.hq.trim() ? p.hq.trim() : undefined,
      employees: typeof p?.employees === "string" && p.employees.trim() ? p.employees.trim() : undefined,
      domain: typeof p?.domain === "string" && p.domain.trim() ? p.domain.trim() : undefined,
      linkedin: typeof p?.linkedin === "string" && p.linkedin.trim() ? p.linkedin.trim() : undefined,
      fit: typeof p?.fit === "string" && p.fit.trim() ? p.fit.trim() : "Matches the ICP characteristics.",
      signals,
      matchPct: 88,
    };
  });
}

/** Classify firm NAMES as buyers vs AI vendors/competitors; keep only buyers.
 *  Backstop for firm-discovery so a competitor can never seed the people-search
 *  even if it slipped through proposal/extraction. One call (firm lists are
 *  small). Fail-open: keep all on error. */
async function filterBuyerFirms(args: {
  provider: AiProvider;
  firms: string[];
  characteristics: string;
  userId: string;
  userKeys?: UserKeys;
}): Promise<string[]> {
  const { provider, firms, characteristics, userId, userKeys } = args;
  if (firms.length === 0) return [];
  try {
    const out = await aiJson<{ verdicts: Array<{ firm: string; type: "buyer" | "vendor" | "unknown" }> }>(
      provider,
      `Classify each company as a BUYER or a VENDOR for this ICP.

ICP / the solution being sold INTO customers:
${characteristics}

- "vendor": core business is building or selling AI/ML technology — foundation-model labs, AI agent/copilot platforms, AI dev-tooling/infra, or AI consultancies. Competitors, NOT prospects.
- "buyer": operates in a target customer industry (banking, insurance, payments, retail, healthcare, manufacturing, etc.) and would CONSUME the solution.
- "unknown": you cannot tell.

Reject only "vendor". Return {"verdicts": [{"firm": "<name>", "type": "buyer"}, ...]} — one per company, echoing the name exactly.`,
      JSON.stringify(firms),
      { maxTokens: 1500, userId, userKeys },
    );
    const verdicts = Array.isArray(out.verdicts) ? out.verdicts : [];
    const vendor = new Set(
      verdicts.filter((v) => v?.type === "vendor" && typeof v.firm === "string").map((v) => v.firm.toLowerCase().trim()),
    );
    return firms.filter((f) => !vendor.has(f.toLowerCase().trim()));
  } catch (e) {
    console.warn("[find] buyer-firm filter failed — keeping all:", (e as Error).message);
    return firms;
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Legacy: handleDiscovery + _filterDiscoveryResults (chat-discovery.js)
// ═════════════════════════════════════════════════════════════════════════

interface FunnelStats {
  extracted: number;
  afterClean: number;
  afterBriefFilter: number;
  afterConfidence: number;
  /** Survivors of the seniority gate. Equal to afterConfidence when no
   *  seniority floor was set (gate skipped). When a floor IS set, the gap
   *  between afterConfidence and afterSeniorityGate is the diagnostic for
   *  "the brief asked for MD+ but Tavily kept returning VPs" — it tells
   *  the user the floor IS being enforced and how aggressively. */
  afterSeniorityGate: number;
  afterArchetypeGate: number;
  /** Count of candidates that survived all filters but were dropped at
   *  intake because their name was already in alreadyShownNames — i.e.
   *  in the user's CRM or surfaced in a prior chat turn. Tracked here
   *  so the empty-result diagnostic can call it out: "found 30, but 30
   *  were already in your CRM" is very different from "search filters
   *  killed everything." */
  excludedAsAlreadyShown: number;
}

interface HandleDiscoveryResult {
  people: Candidate[];
  funnel: FunnelStats;
  /** Candidates that passed every earlier filter but the archetype gate
   *  classified as null. Carried out so the caller can fall back to
   *  surfacing them when the gate rejected the entire pool. */
  rejectedByArchetype: Candidate[];
  /** Candidates the seniority gate dropped as below-floor. Tracked
   *  separately from rejectedByArchetype so the diagnostic can name the
   *  right cause ("found 12 but all were below the MD floor"). */
  rejectedBySeniority: Candidate[];
}

async function handleDiscovery(args: {
  provider: AiProvider;
  query: string;
  targetCount: number;
  extractionHint: string;
  parsed: ParsedBrief | null;
  userId: string;
  userKeys?: UserKeys;
  matchBreadth: MatchBreadth;
  searchBudget: { remaining: number };
}): Promise<HandleDiscoveryResult> {
  const { provider, query, targetCount, extractionHint, parsed, userId, userKeys, matchBreadth, searchBudget } = args;

  const funnel: FunnelStats = {
    extracted: 0, afterClean: 0, afterBriefFilter: 0,
    afterConfidence: 0, afterSeniorityGate: 0, afterArchetypeGate: 0, excludedAsAlreadyShown: 0,
  };

  const raw = await parallelDiscovery({
    provider,
    query,
    targetCount,
    extractionHint,
    parsed,
    userId,
    userKeys,
    searchBudget,
  });
  funnel.extracted = raw.length;

  if (raw.length === 0) return { people: [], funnel, rejectedByArchetype: [], rejectedBySeniority: [] };

  // Legacy _filterDiscoveryResults
  let people = raw;
  people = dedupByName(people);
  people = cleanBadEntries(people);
  funnel.afterClean = people.length;
  people = applyBriefFilters(people, parsed);
  funnel.afterBriefFilter = people.length;

  // Legacy handleDiscovery tail: drop low confidence, sort high→medium.
  people = people.filter((p) => p.confidence !== "low");
  funnel.afterConfidence = people.length;
  const confOrder: Record<string, number> = { high: 0, medium: 1 };
  people.sort((a, b) => (confOrder[a.confidence] ?? 1) - (confOrder[b.confidence] ?? 1));

  // Seniority gate — semantic classifier for the seniorityFloor. Runs ONLY
  // when the brief specified a floor (most briefs don't, so this is free for
  // them). Catches the "MD or above" → VP/EVP leakage that the extractor's
  // soft floor rule lets through. Done as a dedicated LLM pass (not folded
  // into the archetype gate) because:
  //   1. Most briefs have a floor without archetypes — folding would skip
  //      this for those briefs.
  //   2. Reasoning about seniority ladders is mechanically different from
  //      reasoning about role semantics — combining the two prompts hurt
  //      classification accuracy in earlier iterations of the archetype gate.
  let rejectedBySeniority: Candidate[] = [];
  if (parsed?.seniorityFloor && people.length > 0) {
    const before = people.length;
    const gated = await gateBySeniority({ provider, parsed, candidates: people, userId, userKeys });
    people = gated.kept;
    rejectedBySeniority = gated.rejected;
    console.log(`[find] seniority gate (floor="${parsed.seniorityFloor}"): ${before} → ${people.length} (kept) / ${rejectedBySeniority.length} (rejected)`);
  }
  funnel.afterSeniorityGate = people.length;

  // Company-type gate — drop candidates whose EMPLOYER is an AI vendor /
  // competitor (model labs, AI agent/tooling platforms) rather than a buyer in
  // the target industries. Runs BEFORE the archetype gate so a perfect title
  // match at a competitor (e.g. "Chief AI Officer, Cohere") never even reaches
  // archetype classification. Only for archetype-driven briefs that aren't
  // explicitly prospecting AI-vendor employees. Rejects are DROPPED entirely,
  // not added to the rescue pool — a competitor must never resurface as a
  // best-effort result when the gates empty the pool.
  if (
    parsed && parsed.archetypes.length > 0 && !parsed.targetsAiVendors &&
    people.length > 0
  ) {
    const before = people.length;
    const gated = await gateByCompanyType({ provider, parsed, candidates: people, userId, userKeys });
    people = gated.kept;
    if (gated.rejected.length > 0) {
      console.log(`[find] company-type gate: ${before} → ${people.length} (kept) / ${gated.rejected.length} dropped as competitor/AI-vendor`);
    }
  }

  // Archetype gate — dedicated semantic classifier. Only runs when the
  // brief listed archetypes or anti-patterns (so simple "find me COOs at
  // Jefferies" briefs are unaffected). Without this, the extractor
  // routinely smuggles through sector-coverage bankers whose titles look
  // right ("Head of Technology Investment Banking") but whose actual role
  // is an anti-pattern (tech-sector M&A, not AI deployment).
  let rejectedByArchetype: Candidate[] = [];
  if (parsed && (parsed.archetypes.length > 0 || parsed.antiPatterns.length > 0) && people.length > 0) {
    const before = people.length;
    const gated = await gateByArchetype({ provider, parsed, candidates: people, userId, userKeys, matchBreadth });
    people = gated.kept;
    rejectedByArchetype = gated.rejected;
    console.log(`[find] archetype gate: ${before} → ${people.length} (kept) / ${rejectedByArchetype.length} (rejected)`);
  }
  funnel.afterArchetypeGate = people.length;

  return { people, funnel, rejectedByArchetype, rejectedBySeniority };
}

/** Semantic seniority gate. Given a free-text seniority floor (e.g.
 *  "Managing Director or above") and a batch of candidates, classify each
 *  as above_floor / below_floor / ambiguous. Drops below_floor; keeps the
 *  other two. The LLM does the per-firm semantic compare so we don't need
 *  a hardcoded title ladder — "Partner" at a PE firm clears MD; "Senior
 *  Manager" at Big-4 doesn't. Batched into groups of 25 per LLM call. */
async function gateBySeniority(args: {
  provider: AiProvider;
  parsed: ParsedBrief;
  candidates: Candidate[];
  userId: string;
  userKeys?: UserKeys;
}): Promise<{ kept: Candidate[]; rejected: Candidate[] }> {
  const { provider, parsed, candidates, userId, userKeys } = args;
  const floor = parsed.seniorityFloor;
  if (!floor) return { kept: candidates, rejected: [] };
  const BATCH = 25;
  const batches: Candidate[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    batches.push(candidates.slice(i, i + BATCH));
  }
  const results = await Promise.all(
    batches.map(async (batch) => {
      const roster = batch.map((c, idx) => ({
        id: idx,
        name: c.name,
        title: c.title,
        company: c.company,
        evidence: c.evidence ?? "",
      }));
      try {
        const out = await aiJson<{ verdicts: Array<{ id: number; verdict: "above_floor" | "below_floor" | "ambiguous"; reason: string }> }>(
          provider,
          `You classify each candidate against a SENIORITY FLOOR from a prospecting brief. The floor is the MINIMUM acceptable seniority — candidates BELOW the floor must be rejected.

SENIORITY FLOOR: "${floor}"

HOW TO DECIDE — semantic, per-firm, not a hardcoded title ladder.
- Read the candidate's title + company + evidence. Reason about where THAT title sits in THAT firm's ladder, not in a generic ladder.
- Title ladders are firm-specific. The same word means different things at different firms:
    • "Partner" — at McKinsey/BCG/Bain, PE firms (KKR/Blackstone), and law firms = MD-equivalent or above. CLEARS an "MD or above" floor. At an ad agency or small startup it can be junior.
    • "Managing Director" — at investment banks (GS, MS, JPM) sits at MD level. At a small consulting boutique it can be the firm's owner (above MD). At some European firms "Director" is the equivalent of US "Managing Director" — judge by firm context.
    • "Director" — at most large US firms = below MD. At European firms it can BE the MD-equivalent ("Director" at UBS Switzerland, Deutsche Bank, Roland Berger). When in doubt → ambiguous.
    • "VP" — at investment banks = below MD (analyst → associate → VP → MD). At Big Tech (Google/Meta/Amazon) "VP" can be senior leadership above MD-equivalent.
    • "EVP" / "SVP" — at US banks usually above MD; at European banks often below. Use evidence.
    • "Head of <function>" — could be anywhere. Default to ambiguous unless evidence implies seniority (e.g. "leads the global function", "reports to the CEO" → above_floor).
    • C-suite ("Chief X Officer", "CEO", "Chair", "President", "Founder") clears almost any floor short of an enum like "C-suite only at FAANG-tier".

CLASSIFICATION RULES
- "above_floor": Title clearly meets or exceeds the floor for this firm. The candidate's role is at least as senior as what the brief asked for.
- "below_floor": Title is unambiguously below the floor for this firm. Examples for an "MD or above" floor: Analyst, Associate, Senior Associate, Manager, Senior Manager, Assistant VP, Vice President at an IB, Director (US large-firm context with no further seniority signal), Principal at most firms, Lead, Specialist, Consultant.
- "ambiguous": Title genuinely could go either way at this firm. Examples: bare "Director" at a non-IB firm, "Head of <function>" with no scope evidence, "Partner" at an unknown firm type. Keep ambiguous candidates — better a false positive than missing real MDs.

REASON FIELD
- Cite the title and the floor and one phrase about firm context. Examples:
    "Title 'Vice President, Equity Sales' at Goldman Sachs sits below MD on the IB ladder — below_floor"
    "Title 'Partner' at KKR is MD-equivalent at a PE firm — above_floor"
    "Title 'Director' at UBS is ambiguous — could be MD-equivalent (European bank) or sub-MD"

Return {"verdicts": [{"id": 0, "verdict": "above_floor", "reason": "..."}, ...]} — one entry per candidate.`,
          JSON.stringify(roster, null, 2),
          { maxTokens: 2500, userId, userKeys },
        );
        const verdicts = Array.isArray(out.verdicts) ? out.verdicts : [];
        const kept: Candidate[] = [];
        const rejected: Candidate[] = [];
        batch.forEach((c, idx) => {
          const v = verdicts.find((x) => x.id === idx);
          if (!v) {
            // No verdict returned — fail-open, keep the candidate. Better
            // to surface a maybe-too-junior person than to silently drop
            // a real match because the LLM dropped a row.
            kept.push(c);
            return;
          }
          if (v.verdict === "below_floor") {
            const reason = v.reason?.trim() || `Title appears below the "${floor}" bar`;
            const seniorityEvidence = `Below seniority floor: ${reason}`;
            const combined = c.evidence ? `${seniorityEvidence} — ${c.evidence}` : seniorityEvidence;
            rejected.push({ ...c, evidence: combined });
            return;
          }
          // above_floor or ambiguous → keep. Don't decorate evidence on
          // pass-through; only the rejection path needs it for the
          // diagnostic.
          kept.push(c);
        });
        return { kept, rejected };
      } catch (e) {
        console.warn("[find] seniority gate batch failed — keeping candidates:", (e as Error).message);
        // Fail-open on transient errors. The extractor's soft floor rule
        // already weeds out the most obvious below-floor titles, so
        // dropping the gate entirely doesn't make things worse than
        // pre-fix behaviour.
        return { kept: batch, rejected: [] as Candidate[] };
      }
    }),
  );
  return {
    kept: results.flatMap((r) => r.kept),
    rejected: results.flatMap((r) => r.rejected),
  };
}

/** Company-type gate. Rejects candidates whose CURRENT EMPLOYER is an AI/ML
 *  technology VENDOR — a foundation-model lab, an AI agent/copilot platform,
 *  or an AI developer-tooling/infra company — i.e. a competitor that SELLS the
 *  kind of solution the brief is about, not a BUYER in the target industries.
 *
 *  Fixes the "find more in adjacent companies" wander: with no firm anchor a
 *  bare "Head of AI" query returns the web's most prominent Heads of AI —
 *  OpenAI / Meta / Cohere leaders — which are perfect TITLE matches but are
 *  the user's competition. The decision is EMPLOYER-based, not title-based, so
 *  a "Head of AI" at a bank is kept while a "Chief AI Officer" at a model lab
 *  is dropped. Runs only for archetype-driven briefs that aren't explicitly
 *  prospecting AI-vendor employees. Batched 25/call, fail-open. */
async function gateByCompanyType(args: {
  provider: AiProvider;
  parsed: ParsedBrief;
  candidates: Candidate[];
  userId: string;
  userKeys?: UserKeys;
}): Promise<{ kept: Candidate[]; rejected: Candidate[] }> {
  const { provider, parsed, candidates, userId, userKeys } = args;
  const BATCH = 25;
  const batches: Candidate[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    batches.push(candidates.slice(i, i + BATCH));
  }
  const briefContext = parsed.context?.trim() || parsed.archetypes.join("; ") || "(not specified)";
  const results = await Promise.all(
    batches.map(async (batch) => {
      const roster = batch.map((c, idx) => ({
        id: idx, name: c.name, title: c.title, company: c.company, evidence: c.evidence ?? "",
      }));
      try {
        const out = await aiJson<{ verdicts: Array<{ id: number; verdict: "buyer" | "vendor" | "unknown"; reason: string }> }>(
          provider,
          `You filter prospecting candidates by their CURRENT EMPLOYER'S business type.

The brief targets BUYERS — people at customer organisations who would ADOPT or PURCHASE the solution it describes. Anyone whose employer SELLS that same kind of solution is a COMPETITOR/VENDOR, not a prospect, and must be rejected — even when their job title is a perfect match.

WHAT THE BRIEF IS ABOUT (the solution being sold INTO customers):
${briefContext}

CLASSIFY each candidate's EMPLOYER — judge the COMPANY using real-world knowledge, NOT the person's title:
- "vendor": the employer's CORE BUSINESS is building or selling AI/ML technology — a foundation-model lab, an AI agent / copilot / assistant platform, an AI developer-tooling or ML-infrastructure company, or a consultancy whose product is deploying AI for clients. These are competitors. Illustrative (NOT exhaustive — use your own knowledge): OpenAI, Anthropic, Cohere, Mistral, xAI, Hugging Face, Google DeepMind / Google AI, Meta AI / FAIR / GenAI / Superintelligence Labs, Microsoft AI / Copilot, NVIDIA's AI org, Databricks, Scale AI, Glean, Sierra, Adept, Inflection — plus any startup whose pitch is "we build AI agents / models / tooling".
- "buyer": the employer operates in a target customer industry (e.g. banking, insurance, payments, retail, healthcare, manufacturing) and would CONSUME AI rather than sell it. A bank, insurer, or payments network is a BUYER even when the candidate's title contains "AI" — e.g. "Head of AI" at Monzo or "Chief AI Officer" at a bank → buyer, KEEP.
- "unknown": you genuinely cannot tell what the company does. KEEP these (fail open — never guess "vendor").

Reject ONLY "vendor". Keep "buyer" and "unknown".

Return {"verdicts": [{"id": 0, "verdict": "buyer", "reason": "<one line: what the company does>"}, ...]} — one entry per candidate.`,
          JSON.stringify(roster, null, 2),
          { maxTokens: 2000, userId, userKeys },
        );
        const verdicts = Array.isArray(out.verdicts) ? out.verdicts : [];
        const kept: Candidate[] = [];
        const rejected: Candidate[] = [];
        batch.forEach((c, idx) => {
          const v = verdicts.find((x) => x.id === idx);
          // Only an explicit "vendor" verdict rejects — missing/buyer/unknown
          // all keep, so a dropped row or hedge never loses a real buyer.
          if (!v || v.verdict !== "vendor") { kept.push(c); return; }
          const reason = v.reason?.trim() || `${c.company} is an AI vendor/competitor, not a target buyer`;
          const ev = `Rejected as competitor/AI-vendor: ${reason}`;
          rejected.push({ ...c, evidence: c.evidence ? `${ev} — ${c.evidence}` : ev });
        });
        return { kept, rejected };
      } catch (e) {
        console.warn("[find] company-type gate batch failed — keeping candidates:", (e as Error).message);
        return { kept: batch, rejected: [] as Candidate[] };
      }
    }),
  );
  return { kept: results.flatMap((r) => r.kept), rejected: results.flatMap((r) => r.rejected) };
}

/** Semantic archetype gate. Given the brief's archetype definitions and
 *  anti-patterns, classify each candidate: archetype (1-N) or null. Drops
 *  nulls. Attaches the archetype label to evidence so the UI can show WHY
 *  a person qualified — and so the user can spot mis-classifications.
 *
 *  Batched into groups of 20 per LLM call to keep latency low on 100-person
 *  briefs without blowing the output-token budget. */
async function gateByArchetype(args: {
  provider: AiProvider;
  parsed: ParsedBrief;
  candidates: Candidate[];
  userId: string;
  userKeys?: UserKeys;
  matchBreadth: MatchBreadth;
}): Promise<{ kept: Candidate[]; rejected: Candidate[] }> {
  const { provider, parsed, candidates, userId, userKeys, matchBreadth } = args;
  const BATCH = 20;
  const batches: Candidate[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    batches.push(candidates.slice(i, i + BATCH));
  }
  const archetypeBlock = parsed.archetypes.length
    ? parsed.archetypes.map((a, i) => `  ${i + 1}. ${a}`).join("\n")
    : "(none listed)";
  const antiPatternBlock = parsed.antiPatterns.length
    ? parsed.antiPatterns.map((a) => `  - ${a}`).join("\n")
    : "(none listed)";
  // The user's per-search breadth toggle. "broad" (default) treats the named
  // archetypes as EXAMPLES and accepts adjacent senior roles in the same
  // function family — fixes the "I named 'Head of AI, etc.' and it rejected
  // the Chief AI Officer / VP of AI" complaint. "strict" matches only the
  // archetypes as written.
  const breadthBlock = matchBreadth === "broad"
    ? `MATCH BREADTH: BROAD (default).
- The ROLE ARCHETYPES above are EXAMPLES of the kind of person wanted, NOT an exhaustive whitelist. Briefs routinely end archetype lists with "etc." — honour that intent.
- Match on the FUNCTION + SENIORITY, not the exact title string. ACCEPT adjacent / sibling senior roles in the same function family as a listed archetype. E.g. if an archetype is "Head of AI / Head of AI Transformation", also ACCEPT: Chief AI Officer, Chief Data & AI Officer, Chief Data Officer (with an AI remit), VP/SVP/Head of AI, Head of ML / Data Science, Head of Applied AI, AI/GenAI leads at director level and above, Head of AI Risk/Governance, and similar senior owners of the AI agenda.
- Default to ACCEPT when a candidate is a plausible senior owner of the archetype's function. Reject ONLY when the role is clearly a DIFFERENT function (e.g. Head of Sales, Marketing, Legal) or trips a positively-evidenced anti-pattern.
- Seniority floor still applies: drop people clearly junior to the archetype's level.`
    : `MATCH BREADTH: STRICT.
- Match ONLY the role archetypes exactly as written. Do NOT widen to adjacent, sibling, or "close enough" titles.
- If a candidate's role is not clearly one of the listed archetypes, return null.`;

  const results = await Promise.all(
    batches.map(async (batch) => {
      const roster = batch.map((c, idx) => ({
        id: idx,
        name: c.name,
        title: c.title,
        company: c.company,
        evidence: c.evidence ?? "",
      }));
      try {
        const out = await aiJson<{ matches: Array<{ id: number; archetype: number | null; reason: string }> }>(
          provider,
          `You classify each candidate against a set of ROLE ARCHETYPES and ANTI-PATTERNS from a prospecting brief.

ROLE ARCHETYPES (a candidate MUST plausibly match one of these):
${archetypeBlock}

ANTI-PATTERNS (reject candidates matching any of these, even if their title looks like an archetype hit):
${antiPatternBlock}

${breadthBlock}

ANTI-PATTERN DISCIPLINE — read this before rejecting anyone:
- Only reject on an anti-pattern when the candidate's title/evidence POSITIVELY shows they match it. The ABSENCE of evidence is NOT a match. "No evidence of X" is never a valid reason to reject — if you cannot see that the person matches the anti-pattern, the anti-pattern does not apply.
- Some "anti-patterns" above may actually describe the nature of the WORK or the TARGET ACCOUNT (e.g. "Not RPA", "beyond point solutions", "regulated") rather than a person's role. Those are NOT person-level disqualifiers — ignore them entirely when classifying a candidate. Never reject a person because their profile doesn't mention a piece of account/work context.
- A candidate who plausibly matches an archetype and triggers NO positively-evidenced anti-pattern must be ACCEPTED.

HOW TO DECIDE — domain-neutral rules
- Read each candidate's title + evidence, then reason about ROLE SEMANTICS, not title keywords.
- DO NOT inject domain assumptions that aren't in the brief above. The brief defines the domain. The archetypes + anti-patterns above are the ONLY accept/reject criteria. Do not introduce industry vocabulary, role categories, division names, or "common traps" that the brief itself did not name. If a concept (e.g. a particular sub-industry or business unit) isn't mentioned in the archetypes/anti-patterns, you do not get to use it as a reason.
- Title-vs-scope trap: senior titles ("Chief X Officer", "Head of Y", "VP Z") often describe a SCOPE that may or may not match the archetype. A "Chief Technology Officer" of a whole firm is different from a "Chief Technology Officer" embedded inside one division. Reject only when the evidence makes clear the SCOPE doesn't match the archetype the brief wants — not on a hunch.
- Be conservative about rejecting on the basis of WHICH division a senior leader sits in. Unless the brief explicitly excludes a division (or the evidence explicitly says "covers X clients" / "head of Y vertical" / "responsible for Z business unit"), an enterprise-wide title (CTO, COO, CIO, Chief Data Officer) at a target firm should be ACCEPTED if it matches an archetype's role, even when the evidence is thin.
- Generic mid-level titles ("Director", "Managing Director", "Vice President") with no further context tell you nothing — look at the full title and evidence; if still ambiguous, return null.
- Ambiguity → null. Better to drop than to ship an anti-pattern. But "I can't see the division they sit in" is NOT ambiguity — that's the default state for a firm-wide title and should be accepted.

REJECTION REASONS — write the reason in the LANGUAGE OF THE BRIEF
- Quote or paraphrase the brief's own archetype/anti-pattern wording. Do NOT invent new domain vocabulary that isn't in the brief.
- Bad reason pattern (invents domain): describing the candidate using an industry, division, or job-family label that does not appear anywhere in the brief above.
- Good reason patterns:
    "Title is firm-wide [title], but no evidence they own the [archetype N scope]"
    "Matches anti-pattern: '[exact phrase from anti-patterns block]'"
    "Role is in [department X named in candidate's evidence], brief asks for [department Y named in archetypes]"

Return {"matches": [{"id": 0, "archetype": 2, "reason": "<one-line reason in the brief's vocabulary>"}, {"id": 1, "archetype": null, "reason": "<one-line reason in the brief's vocabulary>"}, ...]} — one entry per candidate, archetype is the 1-indexed archetype number or null.`,
          JSON.stringify(roster, null, 2),
          { maxTokens: 2000, userId, userKeys },
        );
        const matches = Array.isArray(out.matches) ? out.matches : [];
        const kept: Candidate[] = [];
        const rejected: Candidate[] = [];
        batch.forEach((c, idx) => {
          const m = matches.find((x) => x.id === idx);
          if (!m || m.archetype == null) {
            // Track WHY the gate dropped this person so the fallback path
            // can show the user a reason on each rejected card.
            const reason = m?.reason?.trim() || "Title looked plausible but the role didn't match the brief's archetypes/anti-patterns";
            const archetypeEvidence = `Rejected by archetype gate: ${reason}`;
            const combined = c.evidence ? `${archetypeEvidence} — ${c.evidence}` : archetypeEvidence;
            rejected.push({ ...c, evidence: combined });
            return;
          }
          const label = parsed.archetypes[m.archetype - 1]?.split(/[—–:.\n]/)[0]?.trim() ?? `archetype ${m.archetype}`;
          const archetypeEvidence = `Archetype ${m.archetype} (${label}): ${m.reason || "semantic match"}`;
          const combined = c.evidence ? `${archetypeEvidence} — ${c.evidence}` : archetypeEvidence;
          kept.push({ ...c, evidence: combined });
        });
        return { kept, rejected };
      } catch (e) {
        console.warn("[find] archetype gate batch failed — keeping candidates:", (e as Error).message);
        // Fail-open: if the gate LLM call errors, keep the batch so we don't
        // drop real matches because of a transient API hiccup. Grounding
        // already blocked fabrications.
        return { kept: batch, rejected: [] as Candidate[] };
      }
    }),
  );
  return {
    kept: results.flatMap((r) => r.kept),
    rejected: results.flatMap((r) => r.rejected),
  };
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
  const pastFirms = parsed.pastFirms.map((f) => f.toLowerCase());
  const pastMode = parsed.employmentIntent === "past" && pastFirms.length > 0;

  const exFirmWords = exFirms.map((f) => f.split(/[\s,&]+/).filter((w) => w.length > 2));
  const targetFirmWords = targetFirms.map((f) => f.split(/[\s,&]+/).filter((w) => w.length > 2));
  const pastFirmWords = pastFirms.map((f) => f.split(/[\s,&]+/).filter((w) => w.length > 2));

  const textMatchesAnyFirm = (text: string, firms: string[], firmWords: string[][]): boolean => {
    if (!text) return false;
    const t = text.toLowerCase();
    if (firms.some((f) => t.includes(f) || f.includes(t))) return true;
    return firmWords.some((words) => {
      const matches = words.filter((w) => t.includes(w));
      return matches.length >= 2 || (words.length === 1 && matches.length === 1);
    });
  };

  const companyMatchesExcluded = (company: string) =>
    textMatchesAnyFirm(company, exFirms, exFirmWords);
  const companyMatchesTarget = (company: string) =>
    textMatchesAnyFirm(company, targetFirms, targetFirmWords);
  const companyMatchesPastTarget = (company: string) =>
    textMatchesAnyFirm(company, pastFirms, pastFirmWords);

  const before = people.length;
  const filtered = people.filter((p) => {
    const title = (p.title || "").toLowerCase();
    if (companyMatchesExcluded(p.company)) return false;
    // Word-boundary match for short single-word seniority/title exclusions.
    // Past bug: parseBrief sometimes returned exclude="head" or "chief"
    // for a brief like "not global heads or chiefs" — substring .includes()
    // then dropped EVERY title containing "Head" ("SVP, Head of AI") or
    // "Chief" ("Chief of Staff for the AI org"). Multi-word exclusions
    // ("global head", "chief operating officer") are still substring-
    // matched because they're already specific.
    const titleHasExcludedTerm = (terms: string[]) =>
      terms.some((t) => {
        if (!t) return false;
        if (t.includes(" ")) return title.includes(t);
        const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${esc}\\b`, "i").test(title);
      });
    if (titleHasExcludedTerm(exSeniority)) return false;
    if (titleHasExcludedTerm(exTitles)) return false;
    if (targetFirms.length > 0 && !companyMatchesTarget(p.company)) return false;
    if (pastMode) {
      // Current employer must NOT be a past-target firm — the person has left.
      if (companyMatchesPastTarget(p.company)) return false;
      // And there must be evidence of past employment at a target firm —
      // either in the extracted pastCompanies list or in the evidence text.
      const pastHit =
        (p.pastCompanies ?? []).some((c) => textMatchesAnyFirm(c, pastFirms, pastFirmWords)) ||
        textMatchesAnyFirm(p.evidence ?? "", pastFirms, pastFirmWords);
      if (!pastHit) return false;
    }
    return true;
  });
  console.log(`[find] brief filter (pastMode=${pastMode}): ${before} → ${filtered.length}`);
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
  parsed?: ParsedBrief | null;
  userId: string;
  userKeys?: UserKeys;
  /** Shared, mutable cap on total Tavily calls for the whole find request.
   *  Decremented per call; queries stop firing once it hits 0. */
  searchBudget: { remaining: number };
}): Promise<Candidate[]> {
  const { provider, query, targetCount, extractionHint, parsed, userId, userKeys, searchBudget } = args;
  const remaining = searchBudget.remaining;

  // Fail fast before spending LLM tokens on query generation: if no Tavily
  // key is configured, every search below would throw and (historically)
  // get swallowed into a misleading "Found 0 — firms too obscure". Surface
  // the real cause instead.
  if (!hasTavilyKey(userKeys)) throw new TavilyKeyMissingError();

  // Query budget is driven by THREE factors, not just targetCount:
  //   - baseline throughput (one query returns up to 20 URLs, so
  //     targetCount/5 covers a superset after dedup + grounding + gate);
  //   - archetype breadth — a brief with 4 role archetypes needs at least
  //     3 queries per archetype so each gets real coverage; a brief with 1
  //     archetype doesn't need that expansion;
  //   - firm breadth — when the brief lists many firms, each needs at
  //     least one query touching it (via OR grouping).
  //
  // Repro: a 4-archetype supply-chain brief with ~30 named firms was
  // getting numQueries=10, which bunched firms into 5-per-query OR groups
  // and missed most of the gigafactories / trade associations / trading
  // houses. Scale the budget up with archetype count so coverage matches
  // the brief's breadth.
  const archetypeCount = parsed?.archetypes.length ?? 0;
  const firmCount = (parsed?.firms.length ?? 0) + (parsed?.pastFirms.length ?? 0);
  // When a seniority floor is set, every query becomes narrower (only at-or-
  // above title synonyms) and Tavily hits per query drop. Bump the floor on
  // numQueries by ~50% so total candidate volume stays in the same ballpark
  // as a no-floor brief — otherwise "MD or above" briefs return 5-10 hits
  // when the user asked for 50.
  const floorMultiplier = parsed?.seniorityFloor ? 1.5 : 1;
  // Firm × role coverage. The earlier formula took max(count, archetypes,
  // firms/3) — but for a brief with MANY firms AND several role archetypes,
  // each firm needs to be queried once PER archetype, not just once total.
  // Repro: a 35-firm, ~4-archetype fintech brief asking for 200 prospects
  // got numQueries=40 (count-driven) — barely one query per firm, so most
  // firms were only searched for a single role and the run finished in one
  // thin round. Multiply firm-groups by archetype breadth so coverage
  // scales with the brief's real surface area.
  const firmGroups = Math.ceil(firmCount / 3);          // ~3 firms OR-grouped per query
  const firmRoleCoverage = firmGroups * Math.max(1, archetypeCount);
  // Per-round query count, hard-capped low. Each query fires 1-2 Tavily calls,
  // so this × rounds is what drives credit spend — an earlier cap of 80 ×
  // many rounds burned ~500 searches for ~17 people on an exhausted niche.
  // Also clamp to the request's remaining search budget so we never generate
  // queries we can't afford to fire.
  const PER_ROUND_QUERY_CAP = 16;
  const numQueries = Math.max(1, Math.min(
    PER_ROUND_QUERY_CAP,
    Math.ceil(remaining / 2), // ~2 calls/query — don't exceed the budget
    Math.ceil(
      Math.max(
        Math.ceil(targetCount / 5),
        archetypeCount * 3,   // 3 queries per distinct archetype
        firmRoleCoverage,     // every firm-group touched once per archetype
        8,
      ) * floorMultiplier,
    ),
  ));
  console.log(`[find] query budget: ${numQueries} (target=${targetCount}, firms=${firmCount}, archetypes=${archetypeCount}, searchBudgetLeft=${searchBudget.remaining})`);

  const queriesObj = await aiJson<{ queries: string[] }>(
    provider,
    `You generate LinkedIn search queries to find specific people. Generate exactly ${numQueries} queries from the research brief below. QUALITY OVER QUANTITY — each query will be fired against a 20-result Tavily advanced search, so coverage per query matters more than variant count.

${extractionHint ? `STRUCTURED FILTERS (use these exact firms, titles, and exclusions):\n${extractionHint}\n` : ""}
QUERY FORMAT — every query MUST name at least one specific company from the brief:
  GOOD pattern: "<Title-or-role-keyword> <Firm1> OR <Firm2> OR <Firm3> OR <Firm4>"
  GOOD pattern: "<Title-or-role-keyword> <Firm1> OR <Firm2>" + a different title-keyword in the next query
  BAD:  "<role keyword> <industry-name>" with no company — Tavily returns articles, not people.
  BAD:  Two queries that name the same firm + same title in different word order (wasted calls).

Use the EXACT firm names from the brief. Do NOT substitute well-known firms from the same industry that the brief did not list.

SENIORITY FLOOR — if the filters mention "SENIORITY FLOOR" (minimum bar like "Managing Director or above"), bias every query toward at-or-above titles. The floor is a hard signal: spending a query on a title below it is wasted budget because downstream gates will drop those candidates.
  - Replace generic role keywords with the at-or-above synonym set for the stated floor. Examples:
      • "MD or above" → use "MD" OR "Managing Director" OR "Partner" OR "Head of" OR "Global Head" OR "Chief" OR "President" OR "Founder" OR "CEO" OR "Chair". DO NOT use "VP", "SVP", "EVP", "Director", "Principal", "Lead" — those are below the floor for most firms.
      • "Partner-level or above" → use "Partner" OR "Senior Partner" OR "Managing Partner" OR "Equity Partner" OR "Chief". Skip Associate/Director/Counsel.
      • "C-suite only" → use "Chief" OR "CEO" OR "CTO" OR "CFO" OR "COO" OR "CRO" OR "CIO" OR "CDO" OR "Chair" OR "President". Skip Head/MD/VP/Director.
      • "VP and above" → use "VP" OR "Vice President" OR "SVP" OR "EVP" OR "Managing Director" OR "MD" OR "Partner" OR "Chief" OR "Head of". Skip Director/Manager/Associate.
  - When the brief lists specific role keywords AND a floor, combine them: "(Managing Director OR Partner OR Head of) AI/ML <Firm>" — never bare "AI Director <Firm>" if Director is below the floor.
  - Ambiguous-by-firm titles like "Partner" (MD-equivalent at a PE firm), "Head of X" (could be MD or VP) are FAIR GAME — the seniority gate adjudicates downstream. Just don't query keywords that are unambiguously below the floor.

PAST-EMPLOYER INTENT — if the filters mention "PAST EMPLOYER TARGETS" (people who have LEFT the firm), craft different queries:
  GOOD pattern: "ex-<Firm1> OR ex-<Firm2> OR ex-<Firm3> <role keyword>"
  GOOD pattern: "formerly at <Firm> alumni <role keyword>"
  - Prefix queries with "ex-", "former", "formerly at", "previously at", "alumni of".
  - NEVER just query the company + title (that returns CURRENT employees).

STRATEGY for ${numQueries} queries — archetype-aware coverage:
- If the brief lists multiple ROLE ARCHETYPES, dedicate at least 2-3 queries to EACH archetype. Do not leave any archetype with zero or one query — that's how a "4 types of people" brief ends up with only type-1 hits.
- Group firms with OR when 2-4 firms share the same archetype+title combo. Do NOT cram 5+ firms from DIFFERENT archetypes into one query (Tavily returns only ~20 results — most will be one firm's people).
- OR title variants that are synonyms ("COO OR Chief Operating Officer OR Head of Operations"), not titles from different archetypes.
- Every target firm should appear in at least one query, but a firm named once is fine if it sits in a dense OR group.
- Never generate two queries that point at the same (firm-set, title-set) combination.
- Do NOT generate queries for any EXCLUDED firms listed in the brief.

Return {"queries": [...]} — exactly ${numQueries} queries, each materially different and tied to a specific archetype when archetypes are listed.`,
    query,
    // 2500 was too tight on long firm-list briefs — Tavily query strings
    // packed with OR groups and escaped quotes blow past it mid-second
    // query and the response truncates inside a string. Scale with the query
    // count (~120 tokens/query covers an OR-grouped string + JSON overhead)
    // so an 80-query budget doesn't truncate mid-array; floor at 6000.
    { maxTokens: Math.max(6000, numQueries * 120), userId, userKeys },
  );

  let searchQueries = (queriesObj.queries ?? []).filter(
    (q): q is string => typeof q === "string" && q.trim().length > 0,
  );

  // Near-duplicate filter — the LLM sometimes emits "COO Moelis" and "Chief
  // Operating Officer Moelis" as two separate queries. Token-set Jaccard
  // similarity > 0.75 → treat as a dupe and keep the first one. Cheap,
  // saves ~10-20% of calls on typical briefs.
  searchQueries = dedupeSimilarQueries(searchQueries);

  // Enforce the query budget. The query-gen LLM routinely returns far fewer
  // queries than asked ("generate exactly 40" often yields ~8-12), which
  // silently shrinks the fan-out to a fraction of numQueries — the search
  // then covers only a handful of firm/role combos and finishes suspiciously
  // fast for a large brief. Top up deterministically from the parsed firms ×
  // titles so the actual number of searches matches the intended breadth.
  const llmQueryCount = searchQueries.length;
  if (parsed && searchQueries.length < numQueries) {
    const existing = new Set(searchQueries.map((q) => q.toLowerCase().trim()));
    searchQueries.push(...buildCoverageQueries(parsed, numQueries - searchQueries.length, existing));
  }
  if (searchQueries.length < 3) {
    searchQueries = [
      `${query.slice(0, 80)} LinkedIn`,
      `${query.slice(0, 80)} professionals`,
    ];
  }
  if (searchQueries.length !== llmQueryCount) {
    console.log(`[find] query count: LLM returned ${llmQueryCount}, topped up to ${searchQueries.length} (budget ${numQueries})`);
  }

  // Legacy: maxPerQuery = targetCount > 30 ? 20 : 10
  const maxPerQuery = targetCount > 30 ? 20 : 10;

  // Per-query outcome — distinguishes a query that RAN and returned zero
  // hits from one that ERRORED (transient 5xx / timeout / network). A query
  // that errors returns { results: [], error } rather than swallowing the
  // failure into an empty list, so the aggregation below can tell "the web
  // legitimately had nothing" apart from "the search itself fell over".
  type QueryOutcome = { results: TavilyResult[]; error: Error | null };
  // Budget-guarded Tavily call: returns null (no call made) once the shared
  // search budget for this find request is spent, so a single search can
  // never run away with hundreds of Tavily credits. JS is single-threaded so
  // the check-then-decrement is atomic between awaits even under concurrency.
  const budgetedSearch = async (q: string, opts: Parameters<typeof tavilySearch>[1]): Promise<TavilyResult[] | null> => {
    if (searchBudget.remaining <= 0) return null;
    searchBudget.remaining--;
    return tavilySearch(q, opts);
  };
  const runQuery = async (sq: string): Promise<QueryOutcome> => {
    const cleanQuery = sq.replace(/\s*site:\S+\s*/gi, " ").trim();
    try {
      // 1. Advanced + include_domains: linkedin.com
      const linked = await budgetedSearch(cleanQuery, {
        depth: "advanced",
        maxResults: maxPerQuery,
        includeDomains: ["linkedin.com"],
        userId,
        userKeys,
      });
      if (linked === null) return { results: [], error: null }; // budget spent
      if (linked.length > 0) return { results: linked, error: null };
      // 2. Advanced + "LinkedIn profile" suffix, open web
      const open = await budgetedSearch(`${cleanQuery} LinkedIn profile`, {
        depth: "advanced",
        maxResults: maxPerQuery,
        userId,
        userKeys,
      });
      return { results: open ?? [], error: null };
    } catch (e) {
      // Quota/auth/missing-key errors must NOT be silently swallowed —
      // without this, a Tavily 432 "out of credits" turns into "Found 0 —
      // try a more specific brief", which is wildly misleading. Re-throw so
      // the chat handler can surface a clear, actionable card.
      if (isTavilyQuotaError(e) || isTavilyAuthError(e) || e instanceof TavilyKeyMissingError) throw e;
      // 3. Basic fallback for everything else (transient 5xx, timeouts).
      try {
        const basic = await budgetedSearch(cleanQuery, {
          depth: "basic",
          maxResults: 10,
          userId,
          userKeys,
        });
        return { results: basic ?? [], error: null };
      } catch (e2) {
        if (isTavilyQuotaError(e2) || isTavilyAuthError(e2) || e2 instanceof TavilyKeyMissingError) throw e2;
        // Both attempts failed for a transient reason — record the error so
        // the aggregation can tell whether EVERY query died (search failure)
        // vs this one query coming up empty.
        console.warn(`[find] tavily query failed: "${cleanQuery.slice(0, 80)}" → ${(e2 as Error).message}`);
        return { results: [], error: e2 as Error };
      }
    }
  };

  // Run searches in bounded waves rather than all at once. With the budget
  // now enforced (up to 80 queries), firing them all simultaneously risks
  // tripping Tavily's rate limit — which the client treats as a quota error
  // and would abort the whole run. A concurrency cap keeps the load steady
  // and lets a genuine quota/auth error still propagate (the pool rejects on
  // the first throw). 16 in flight stays near the unbounded fan-out the run
  // historically tolerated, while smoothing an 80-query budget into ~5 waves
  // so it neither bursts Tavily nor blows past the client's request timeout.
  const SEARCH_CONCURRENCY = 16;
  const outcomes = await mapWithConcurrency(searchQueries, SEARCH_CONCURRENCY, runQuery);
  const erroredQueries = outcomes.filter((o) => o.error);
  const allResults = outcomes.flatMap((o) => o.results);

  // If EVERY query errored, the web search didn't run — it fell over. Throw
  // a typed error so the user sees "search failed, try again" instead of the
  // misleading "firms too obscure" funnel diagnostic. (A mix of errors and
  // genuine-empty results falls through to the normal empty handling.)
  if (allResults.length === 0 && erroredQueries.length === searchQueries.length && searchQueries.length > 0) {
    throw new WebSearchFailedError(erroredQueries[0]!.error!.message);
  }
  if (allResults.length === 0) {
    console.log(`[find] parallel: ${searchQueries.length} queries → 0 raw (web search ran, genuinely no results)`);
    return [];
  }

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

  // Server-side grounding — reject any candidate whose full name doesn't
  // appear verbatim in at least one raw Tavily snippet. This is the only
  // defence against LLM fabrication that can't be undone by prompt drift:
  // if the name isn't in the source material, we refuse to surface it no
  // matter what the extractor returned. Without this, the extractor would
  // confidently invent plausible-sounding executives (e.g. "John G. Schmidt,
  // COO Investment Banking, Jefferies") when Tavily returned weak snippets
  // for a target firm/title combo.
  const snippetHaystack = buildSnippetHaystack(unique);
  const grounded: Candidate[] = [];
  let rejected = 0;
  for (const p of allPeople) {
    if (nameAppearsInSnippets(p.name, snippetHaystack)) {
      grounded.push(p);
    } else {
      rejected++;
    }
  }
  if (rejected > 0) {
    console.log(`[find] grounding: rejected ${rejected} candidate(s) whose names were not in any snippet`);
  }

  // Dedupe by name (parallelDiscovery's own dedup — handleDiscovery will
  // dedupe again after the filter pipeline)
  const nameSet = new Set<string>();
  return grounded.filter((p) => {
    if (!p.name) return false;
    const key = p.name.toLowerCase().trim();
    if (nameSet.has(key)) return false;
    nameSet.add(key);
    return true;
  });
}

/** Lowercase, strip punctuation, collapse whitespace — so "John G. Schmidt"
 *  grounds against a snippet that says "John Schmidt" or "john g schmidt". */
function normalizeForGrounding(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function buildSnippetHaystack(results: TavilyResult[]): string {
  return normalizeForGrounding(
    results.map((r) => `${r.title ?? ""} ${r.url ?? ""} ${r.content ?? ""}`).join(" \n "),
  );
}

/** A name is "grounded" if its first AND last token both appear somewhere
 *  in the snippets — adjacent OR within a short window of each other. The
 *  window check catches snippets that say "Jane M. Doe" when the LLM
 *  returned "Jane Doe", or "Doe, Jane" in a list. Middle initials and
 *  punctuation are ignored via normalizeForGrounding. */
function nameAppearsInSnippets(name: string, haystack: string): boolean {
  const norm = normalizeForGrounding(name);
  if (!norm) return false;
  if (haystack.includes(norm)) return true;
  const tokens = norm.split(" ").filter((t) => t.length >= 2);
  if (tokens.length < 2) return false;
  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;
  if (!haystack.includes(first) || !haystack.includes(last)) return false;
  // Proximity check: first and last must co-occur within ~80 chars of each
  // other at least once. Otherwise "John" appearing in one snippet and
  // "Schmidt" in another would spuriously ground "John Schmidt".
  const WINDOW = 80;
  let idx = 0;
  while ((idx = haystack.indexOf(first, idx)) !== -1) {
    const slice = haystack.slice(Math.max(0, idx - WINDOW), idx + first.length + WINDOW);
    if (slice.includes(last)) return true;
    idx += first.length;
  }
  return false;
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

${extractionHint ? extractionHint + "\n" : ""}DEFAULT BEHAVIOR — be PERMISSIVE, not paranoid.
- The brief above tells you which firms and titles the user wants. If a snippet shows the candidate's name AND a title that plausibly matches one in the brief AND a current employer that matches one of the target firms, ACCEPT. That is the common case.
- Do not invent reasons to reject. If the user listed "Head of AI" as a target title and the snippet shows "Head of AI" at a target firm, that is a match — even if you can imagine an alternate reading of the title.
- Stay inside the brief's domain. Do not import role categories, divisions, or industry vocabulary that the brief did not mention. The brief's filters are the only filter — your job is matching, not domain expansion.

WHEN TO BE STRICTER — only when the brief explicitly tells you to.
- ROLE ARCHETYPES (if listed in the structured filters above): a candidate must SEMANTICALLY match one of the archetypes, not just keyword-match. If the brief lists no archetypes, this rule does NOT apply — fall back to title+firm matching only.
- ANTI-PATTERNS (if listed): reject candidates that match an anti-pattern, even if their title looks right. If the brief lists no anti-patterns, do NOT invent any.
- SENIORITY FLOOR (if listed): drop any candidate whose title is UNAMBIGUOUSLY below the stated bar. Do the comparison semantically per-firm — "Partner" at a PE firm clears an "MD or above" floor; "Senior Manager" at a Big-4 does not. When the candidate's title alone is ambiguous (bare "Director" with no further scope), KEEP them — a downstream gate will adjudicate. Do NOT pre-filter on ambiguity.
- Title scope nuance: composite titles like "Head of <X> <Y>" can sometimes mean either (a) <Y> applied internally for <X>, or (b) <Y> services delivered to <X> as a client. Only consider this distinction when the brief's anti-patterns explicitly exclude one variant. Otherwise, accept the title at face value.
- When archetypes ARE listed and a candidate is genuinely ambiguous against them, prefer to REJECT — empty is better than wrong. This rule does NOT apply to flat firm+title briefs without archetypes.

THE ONLY SOURCE OF TRUTH IS THE SNIPPETS BELOW.
- Every person you return MUST have their full name appear verbatim in at least one snippet. If the name is not written in the snippets, DO NOT return them — even if you "know" someone in that role at that firm from training data. We verify this server-side and will drop any ungrounded candidates.
- Never infer a person from a firm + title combination. If the snippets don't name them, they don't exist for this query.
- The "evidence" field MUST be a short verbatim quote (≤140 chars) copied from the snippet that contains their name and role. No paraphrasing.

MANDATORY FILTERS — every candidate must pass ALL of these:
1. FULL NAME: Written verbatim in a snippet. Real first AND last name (skip initials, "John S.").
2. CURRENT EMPLOYER: Stated in the snippet as their current employer. ${extractionHint ? "If filters above list TARGET FIRMS, current employer must match one. If filters list PAST EMPLOYER TARGETS instead, current employer must NOT be any of those past-target firms — the person has LEFT." : ""}
3. CURRENT TITLE: Stated in the snippet (LinkedIn headline, bio line, press quote attribution). Do NOT infer from article context.
4. LINKEDIN PROFILE: Strongly prefer candidates with a linkedin.com/in/ URL in the snippet.
${extractionHint && /PAST EMPLOYER TARGETS/.test(extractionHint) ? `5. PAST EMPLOYMENT at a target: The snippet must name the candidate's prior role at one of the PAST EMPLOYER TARGETS — "ex-Celonis", "previously VP Sales at UiPath", a LinkedIn experience line, a departure announcement, etc. If this isn't in the snippet, reject.\n6. MUST HAVE LEFT: Evidence the person is no longer at the target firm — a newer role at a different company, a "left/departed/joined X from Y" mention, or a LinkedIn headline that names a non-target company. Still-employed candidates fail this filter.\n` : ""}

FAILURE MODES TO AVOID:
- FABRICATION: Do not invent plausible-sounding executives to fill a quota. Empty result is fine.
- CLUSTER HARVESTING: If an article mentions 5 people at an event, do NOT extract all 5. Each must independently appear with their own name+title+employer.
- KEYWORD CONFLATION: A profile mentioning "AI" at a "bank" is NOT automatically qualified. Check the actual title and actual employer.
- ARTICLE AUTHORS/COMMENTERS: Writers of articles about the persona are NOT leads.
- STALE DATA: If the source is old, the person may have moved on. Exclude or mark medium.

CONFIDENCE SCORING — be strict:
- "high": Name, current employer (= target firm), current title (= target title), and LinkedIn URL all appear in the same snippet.
- "medium": Three of the four are present in the snippet.
- Do NOT include anyone you'd rate below medium.

Return {"candidates": [...]} of ONLY qualified candidates (high or medium). Each candidate:
{"name":"Full Name","title":"Current Title","company":"Current Employer","linkedin":"linkedin.com/in/ URL or empty","evidence":"≤140-char verbatim quote from the snippet containing the name","confidence":"high"|"medium","source":"URL"${extractionHint && /PAST EMPLOYER TARGETS/.test(extractionHint) ? `,"pastCompanies":["names of prior employers from the snippet — must include at least one PAST EMPLOYER TARGET firm"]` : ""}}

Do NOT pad results. If only 2 people qualify, return 2. If zero qualify, return {"candidates": []}.`,
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
      } catch (e) {
        // Quota/auth errors must propagate; everything else is a soft fail.
        if (isTavilyQuotaError(e) || isTavilyAuthError(e)) throw e;
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

/** Drop near-duplicate queries using token-set Jaccard similarity. LLMs
 *  often emit "COO Moelis" AND "Chief Operating Officer Moelis" as two
 *  separate queries, which hits Tavily twice for the same (firm, title)
 *  combo. 0.75 threshold keeps distinct intents (different firm sets or
 *  different titles) while catching surface-level rephrasings. Runs
 *  in-order, keeping the first instance of each cluster. */
/** Run `fn` over `items` with at most `limit` calls in flight at once,
 *  preserving result order. Rejects as soon as any call rejects (so a typed
 *  Tavily quota/auth error still aborts the run) — in-flight calls are left
 *  to settle on their own. Used to pace the web-search fan-out so a large
 *  query budget doesn't burst-fire and trip rate limits. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Deterministically build "title firmA OR firmB OR firmC" search queries
 *  from the parsed brief — title × OR-grouped firm combinations. Used to
 *  TOP UP the query list when the LLM returns fewer queries than the budget
 *  asked for (a "generate 40" prompt routinely yields ~10, silently shrinking
 *  the search). `existing` holds normalised query strings already queued so
 *  we don't re-add ones the LLM already produced. Returns at most `need`. */
function buildCoverageQueries(parsed: ParsedBrief, need: number, existing: Set<string>): string[] {
  if (need <= 0) return [];
  // Past mode searches prior employers; otherwise current target firms.
  const firms = parsed.employmentIntent === "past" && parsed.pastFirms.length
    ? parsed.pastFirms
    : parsed.firms;
  if (firms.length === 0) return [];
  // OR-group firms 3 at a time — Tavily returns ~20 results per query, so a
  // group of 3 still gives each firm meaningful coverage.
  const groups: string[][] = [];
  for (let i = 0; i < firms.length; i += 3) groups.push(firms.slice(i, i + 3));
  // Cross every title keyword with every firm-group. No titles → bare firm
  // groups (better than nothing for a "find anyone senior at X" brief).
  const titles = parsed.titles.length ? parsed.titles : [""];
  const prefix = parsed.employmentIntent === "past" ? "ex-" : "";
  const out: string[] = [];
  for (const title of titles) {
    for (const g of groups) {
      if (out.length >= need) return out;
      const q = `${title} ${prefix}${g.join(` OR ${prefix}`)}`.trim();
      const key = q.toLowerCase().trim();
      if (existing.has(key)) continue;
      existing.add(key);
      out.push(q);
    }
  }
  return out;
}

function dedupeSimilarQueries(qs: string[]): string[] {
  const SYNONYMS: Record<string, string> = {
    coo: "chief_operating_officer",
    "chief operating officer": "chief_operating_officer",
    cto: "chief_technology_officer",
    "chief technology officer": "chief_technology_officer",
    cio: "chief_information_officer",
    "chief information officer": "chief_information_officer",
    cfo: "chief_financial_officer",
    "chief financial officer": "chief_financial_officer",
    cro: "chief_revenue_officer",
    "chief revenue officer": "chief_revenue_officer",
    cos: "chief_of_staff",
    "chief of staff": "chief_of_staff",
    cdo: "chief_data_officer",
    "chief data officer": "chief_data_officer",
    "head of ai": "head_of_ai",
    cao: "chief_ai_officer",
    "chief ai officer": "head_of_ai",
    vp: "vice_president",
    "vice president": "vice_president",
  };
  const tokens = (q: string): Set<string> => {
    let s = q.toLowerCase();
    // Apply longest-key-first synonym collapse.
    const keys = Object.keys(SYNONYMS).sort((a, b) => b.length - a.length);
    for (const k of keys) s = s.split(k).join(SYNONYMS[k]!);
    const raw = s.replace(/[^a-z0-9_]+/g, " ").split(/\s+/).filter((t) => t.length >= 2 && t !== "or" && t !== "and");
    return new Set(raw);
  };
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  };
  const kept: Array<{ q: string; toks: Set<string> }> = [];
  for (const q of qs) {
    const toks = tokens(q);
    if (kept.some((k) => jaccard(k.toks, toks) > 0.75)) continue;
    kept.push({ q, toks });
  }
  return kept.map((k) => k.q);
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
  // Strip numbers that look like they're part of something other than a
  // prospect count — "tier 2", "Q3", "20%", four-digit years, $amounts,
  // "1,000+ employees" / "$100M revenue" thresholds, time windows like
  // "last 12 months". Also strip per-account multipliers like "2-3 per
  // company", "find 2 contacts per firm" — those mean "this many EACH",
  // not the grand total, so they must force the clarify gate.
  // Past bugs:
  //   - "tier 2 and tier 3 banks" → targetCount=2 via bare-digit fallback.
  //   - "find 2-3 contacts per company" (across 30 named accounts) →
  //     targetCount=2 because the verb-prefix regex grabbed the "2".
  const cleaned = s
    .replace(/\btier\s*\d+\b/gi, " ")
    .replace(/\bq[1-4]\b/gi, " ")
    .replace(/\b\d+\s*%/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\$\s*\d[\d,]*\+?\s*[kmb]?\b/gi, " ")
    // Employee / size thresholds: "1,000+ employees", "500+ headcount".
    .replace(/\b\d[\d,]*\+?\s*(?:employees?|headcount|staff|fte|people\s+strong|seats?)\b/gi, " ")
    // Time windows: "last 12 months", "in 6 months", "past 30 days".
    .replace(/\b(?:last|past|previous|next|in|within|over)\s+\d{1,3}\s*(?:days?|weeks?|months?|years?|quarters?)\b/gi, " ")
    // Per-account multipliers in any form: "2-3 per company", "2 contacts
    // per firm", "find 3 leads per account". Wipe the digit so neither the
    // verb-prefix nor the noun-suffix regex can latch onto it.
    .replace(/\b\d{1,3}(?:\s*[-–—]\s*\d{1,3})?(?:\s+\w+){0,4}\s+per\s+(?:company|companies|firm|firms|account|accounts|org(?:ani[sz]ation)?s?|business(?:es)?|client|clients|customer|customers|vendor|vendors|provider|providers|target|targets)\b/gi, " ")
    // Numeric ranges anywhere ("2-3", "5–10", "10 to 20", "5 or 10") — the
    // user is sketching a band, not committing to a count. Force clarify.
    .replace(/\b\d{1,3}\s*[-–—]\s*\d{1,3}\b/g, " ")
    .replace(/\b\d{1,3}\s+(?:to|or)\s+\d{1,3}\b/gi, " ");
  const m = cleaned.match(/\b(?:find|get|give|list|top|show|want|need)\s*(?:me\s+)?(?:up\s+to\s+)?(\d{1,3})\b/i)
    ?? cleaned.match(/\b(\d{1,3})\s*(?:prospects?|people|leads?|contacts?|results?|names?)\b/i)
    // Bare-digit fallback ONLY for lines that are just a number — catches
    // the user answering "how many?" with a plain "50". Inline digits in
    // prose are too ambiguous (cf. "tier 2", "top 10 banks", "2 or 3 per
    // firm") and should force the clarify path.
    ?? cleaned.match(/(?:^|\n)\s*(\d{1,3})\s*(?:$|\n)/);
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
  const intent = /(find|identify|locate|who\s+is|looking\s+for|search\s+for|look\s+up|someone\s+(?:named|called)|person\s+(?:named|called)|name(?:d)?\s+(?:like|similar\s+to)|similar\s+to)/.test(hay);
  if (!intent) return false;

  // Disqualifiers — these are strong signals the brief is a multi-prospect
  // search even if the "[Cap][Cap]" name regex matches something like
  // "Senior Vice" or "Wells Fargo". Past bug: "find me SVPs of
  // transformation / AI implementation in the banking sector outside of
  // Wells Fargo" matched the person-lookup path because "Senior Vice"
  // (from "Senior Vice Presidents") looks like a first+last name.
  const pluralRole = /\b(svps?|vps?|coos?|ctos?|ceos?|cfos?|cios?|cros?|evps?|directors?|managers?|leaders?|partners?|heads?\s+of|people|employees|contacts|candidates|prospects|executives|officers)\b/;
  const scope = /\b(in\s+the\s+\w+\s+(sector|industry|space|market|area)|across\s+(?:all\s+)?\w+|at\s+multiple|who\s+(?:have|work|are|cover))\b/;
  const exclusion = /\b(outside\s+of|excluding|except(?:\s+for)?|not\s+at|not\s+from|other\s+than|besides)\b/;
  const newnessCue = /\bn[ew]w\s+(?:ones?|people|prospects|candidates)\b/; // "new ones", typo-tolerant ("nerw")
  if (pluralRole.test(hay) || scope.test(hay) || exclusion.test(hay) || newnessCue.test(hay)) return false;

  return true;
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
  if (!hasTavilyKey(userKeys)) throw new TavilyKeyMissingError();
  const llm =
    provider === "openai" ? (userKeys?.openai ?? env.OPENAI_API_KEY) :
    provider === "anthropic" ? (userKeys?.anthropic ?? env.ANTHROPIC_API_KEY) :
    (userKeys?.deepseek ?? env.DEEPSEEK_API_KEY);
  if (!llm) throw new Error(`${provider.toUpperCase()} key missing — add it in Settings → API keys.`);
}
