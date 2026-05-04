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
import { tavilySearch, type TavilyResult, isTavilyQuotaError, isTavilyAuthError } from "../tavily.js";
import type { UserKeys } from "../user-keys.js";
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
      const clarify = await aiJson<{ ready: boolean; question?: string; count?: number }>(
        provider,
        "You screen a prospecting brief before running a web search. " +
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

    const { people: roundPeople, funnel: roundFunnel, rejectedByArchetype, rejectedBySeniority } = await handleDiscovery({
      provider,
      query: roundQuery,
      targetCount: remaining,
      extractionHint: extractCtx,
      parsed,
      userId,
      userKeys,
    });
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

    // Break-out policy:
    //  - Always break if the round added zero new candidates (the query
    //    generator is producing pure dupes — more rounds won't help).
    //  - Otherwise, only break early if we already have a meaningful
    //    chunk of the target (>= 30% of what was asked). Previously the
    //    loop quit after any round that returned <3 new — which was
    //    way too aggressive on niche briefs where round 1 hits 2 people
    //    but rounds 2 and 3, with different query angles, would have
    //    found more. User reported "way too quick to say it didn't find
    //    them" — that was this break.
    if (newCount === 0) break;
    if (newCount < 3 && allPeople.length >= Math.ceil(targetCount * 0.3)) break;
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
  "pastFirms": ["<exact company name>", ...]
}

Rules:
- Extract EXACT company names mentioned as targets. Do not add companies not named in the brief.
- titles = SHORT searchable keywords (≤4 words each), not verbose verbatim titles.
- archetypes: if the brief numbers or names role categories (e.g. "1. <archetype name>", "Archetype 2: <archetype name>"), capture each as a separate entry WITH its disambiguation rules and exclusions.
- antiPatterns: capture every "exclude X where Y" or "avoid Z" clause the brief lists, in the brief's own wording.
- seniorityFloor: set this WHENEVER the brief states a minimum seniority bar — even casually. Trigger phrases include: "MD or above", "MD+", "MD and up", "Director-level or higher", "Partner level", "C-suite only", "VP and above", "Head-of and up", "senior leadership", "executives only", "decision-makers", "no juniors", "no analysts/associates", "top brass". Write the floor as one short phrase that names the minimum acceptable level AND makes "or above" explicit, e.g. "Managing Director or above", "Partner-level or above", "C-suite (CXO/Chief) only", "Head of <function> or above". If no minimum bar is stated, return null. Do NOT invent a floor that the brief didn't ask for.
- excludeSeniority is for EXCLUSIONS only ("not VPs", "no Directors") — not for floors. When a floor is set, leave excludeSeniority empty unless the brief separately calls out a level to exclude. The seniorityFloor field drives a downstream semantic gate that handles "or above" semantics correctly across firm-specific title ladders.
- employmentIntent: set to "past" when the brief clearly asks for people who USED TO work at the target firms and are no longer there. Trigger phrases: "ex-", "former", "formerly at", "used to work at", "previously at", "have left", "alumni of", "recent leavers from", "departed X". Default to "current" otherwise.
- pastFirms: when employmentIntent = "past", move the target firms to pastFirms AND leave "firms" EMPTY (so current-employer filters pass through). The extractor will then filter on past experience. When employmentIntent = "current", leave pastFirms empty.
- Include all variant spellings of an excluded firm if the brief gives them (e.g. an abbreviation alongside the full name).
- If the brief lists no archetypes or anti-patterns, return empty arrays. Do not invent any.

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
}): Promise<HandleDiscoveryResult> {
  const { provider, query, targetCount, extractionHint, parsed, userId, userKeys } = args;

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

  // Archetype gate — dedicated semantic classifier. Only runs when the
  // brief listed archetypes or anti-patterns (so simple "find me COOs at
  // Jefferies" briefs are unaffected). Without this, the extractor
  // routinely smuggles through sector-coverage bankers whose titles look
  // right ("Head of Technology Investment Banking") but whose actual role
  // is an anti-pattern (tech-sector M&A, not AI deployment).
  let rejectedByArchetype: Candidate[] = [];
  if (parsed && (parsed.archetypes.length > 0 || parsed.antiPatterns.length > 0) && people.length > 0) {
    const before = people.length;
    const gated = await gateByArchetype({ provider, parsed, candidates: people, userId, userKeys });
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
}): Promise<{ kept: Candidate[]; rejected: Candidate[] }> {
  const { provider, parsed, candidates, userId, userKeys } = args;
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
}): Promise<Candidate[]> {
  const { provider, query, targetCount, extractionHint, parsed, userId, userKeys } = args;

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
  const numQueries = Math.min(
    50,
    Math.ceil(
      Math.max(
        Math.ceil(targetCount / 5),
        archetypeCount * 3,   // 3 queries per distinct archetype
        Math.ceil(firmCount / 3), // 1 query per ~3 firms (OR-grouped)
        8,
      ) * floorMultiplier,
    ),
  );

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
    { maxTokens: 2500, userId, userKeys },
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

  // Near-duplicate filter — the LLM sometimes emits "COO Moelis" and "Chief
  // Operating Officer Moelis" as two separate queries. Token-set Jaccard
  // similarity > 0.75 → treat as a dupe and keep the first one. Cheap,
  // saves ~10-20% of calls on typical briefs.
  searchQueries = dedupeSimilarQueries(searchQueries);

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
    } catch (e) {
      // Quota/auth errors must NOT be silently swallowed — without this,
      // a Tavily 432 "out of credits" turns into "Found 0 — try a more
      // specific brief", which is wildly misleading. Re-throw so the
      // chat handler can surface a clear "you're out of credits" card.
      if (isTavilyQuotaError(e) || isTavilyAuthError(e)) throw e;
      // 3. Basic fallback for everything else (transient 5xx, timeouts).
      try {
        return await tavilySearch(cleanQuery, {
          depth: "basic",
          maxResults: 10,
          userId,
          userKeys,
        });
      } catch (e2) {
        if (isTavilyQuotaError(e2) || isTavilyAuthError(e2)) throw e2;
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
  const tavily = userKeys?.tavily ?? env.TAVILY_API_KEY;
  if (!tavily) throw new Error("Tavily key missing — add it in Settings → API keys to enable web search.");
  const llm =
    provider === "openai" ? (userKeys?.openai ?? env.OPENAI_API_KEY) :
    provider === "anthropic" ? (userKeys?.anthropic ?? env.ANTHROPIC_API_KEY) :
    (userKeys?.deepseek ?? env.DEEPSEEK_API_KEY);
  if (!llm) throw new Error(`${provider.toUpperCase()} key missing — add it in Settings → API keys.`);
}
