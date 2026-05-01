/**
 * Network mode — search the user's own LinkedIn connections (people table).
 * One LLM call decomposes the brief into filter keywords, then we score every
 * row client-side against those keywords and return the top matches as
 * Prospect objects. No web calls, no Apollo, cheap.
 */
import type { AiProvider, CompletionResult, Prospect } from "@app/shared";
import { env } from "../../env.js";
import { db } from "../../db/index.js";
import { aiJson } from "../json.js";
import type { UserKeys } from "../user-keys.js";
import { loadMessagedSet, hasMessaged } from "../messaged-set.js";

interface Filters {
  roleKeywords: string[];       // e.g. ["vp engineering", "cto", "head of ai"]
  companyKeywords: string[];    // e.g. ["stripe", "openai"]
  industryKeywords: string[];   // e.g. ["fintech", "ai"]
  excludeCompanies: string[];   // e.g. ["google"] when user says "not at google"
  excludeRoles: string[];       // seniority/role exclusions
  notes: string;                // short free-text about the intent
  /** True when the brief asks for people the user has NOT yet messaged.
   *  Set by the LLM filter parser — handles typos and rephrasings ("havent
   *  reached out", "no outreach yet", "fresh contacts only") that the
   *  fast-path keyword regex would miss. */
  excludeAlreadyMessaged?: boolean;
}

const EMPTY_FILTERS: Filters = {
  roleKeywords: [], companyKeywords: [], industryKeywords: [],
  excludeCompanies: [], excludeRoles: [], notes: "", excludeAlreadyMessaged: false,
};

export async function runNetwork(
  provider: AiProvider,
  userInput: string,
  userId: string,
  userKeys?: UserKeys,
): Promise<CompletionResult> {
  assertLlmKey(provider, userKeys);

  // Question vs. search intent. "what do you think of my banking network",
  // "summarise my fintech contacts", "overview of my engineering people"
  // are analysis requests — the user wants prose, not a ranked list of 12.
  // Fall through to the normal filter+score path below, but at the end
  // pivot to an LLM-written analysis when this flag is set.
  const isAnalysis = isAnalysisIntent(userInput);

  // "Haven't messaged" intent — the user wants the search to filter out
  // people they've already reached out to. Two complementary detectors:
  //   1. Keyword regex (looksLikeHaventMessagedIntent) — fast-path for
  //      common phrasings, runs before the LLM filter call so the value
  //      is available even if that call fails.
  //   2. LLM filter flag (filters.excludeAlreadyMessaged) — set further
  //      down after the LLM parses the brief. Catches typos and unusual
  //      phrasings the regex misses ("ihbavent i sent", "no DMs to them
  //      yet", "cold contacts only").
  // We OR them: either fires → filter applies. Cheap to be permissive
  // because the filter is a no-op when the message log is empty.
  let excludeAlreadyMessaged = looksLikeHaventMessagedIntent(userInput);

  // Load the messaged-set in parallel with the rest of the work below.
  // We always need it (so we can tag matched people who HAVE been
  // messaged), even when excludeAlreadyMessaged is false.
  const messagedSetPromise = loadMessagedSet(userId).catch((e) => {
    console.warn("[network] loadMessagedSet failed:", (e as Error).message);
    return { names: new Set<string>(), linkedinUrls: new Set<string>(), totalCounterparts: 0 };
  });

  // Step 1: decompose the brief into typed filters.
  let filters: Filters = EMPTY_FILTERS;
  try {
    const raw = await aiJson<Partial<Filters>>(
      provider,
      "You convert a prospecting brief into structured filters for searching a local LinkedIn connections table. Be concise: 1-4 keywords per bucket, lowercase. Prefer MULTI-WORD role keywords over single words — a two-word phrase from the brief is much less likely to false-match against unrelated company or category names than a single common word would be. Use the brief's own vocabulary; do not introduce industries or categories the brief did not mention.\n\n" +
      "Set excludeAlreadyMessaged=true when the brief asks for people the user has NOT yet sent a message / DM / email to (any phrasing: 'havent messaged', 'haven't reached out', 'not yet contacted', 'no outreach yet', 'fresh contacts', 'cold leads', 'people I haven't pinged', any common typo or word order). Be GENEROUS with this flag — a false positive (filter drops nothing because no message log exists) is cheap; a false negative (user gets back people they already messaged) is the actual failure mode we're guarding against.",
      `Brief: ${userInput}\n\nReturn {"roleKeywords": [...], "companyKeywords": [...], "industryKeywords": [...], "excludeCompanies": [...], "excludeRoles": [...], "excludeAlreadyMessaged": true|false, "notes": "<one line>"}.\nOnly include values explicitly implied. Empty arrays are fine.`,
      { maxTokens: 400, userId, userKeys },
    );
    filters = {
      roleKeywords: normalize(raw.roleKeywords),
      companyKeywords: normalize(raw.companyKeywords),
      industryKeywords: normalize(raw.industryKeywords),
      excludeCompanies: normalize(raw.excludeCompanies),
      excludeRoles: normalize(raw.excludeRoles),
      notes: typeof raw.notes === "string" ? raw.notes.slice(0, 240) : "",
      excludeAlreadyMessaged: raw.excludeAlreadyMessaged === true,
    };
  } catch {
    // If the LLM decomposition fails, fall back to a raw-text search over the
    // whole input. The scoring below tokenizes the input as a single bucket.
    filters = { ...EMPTY_FILTERS, roleKeywords: tokenize(userInput) };
  }

  // Fold the LLM's understanding into the regex fast-path. Either source
  // setting it true means the user wants messaged people excluded.
  excludeAlreadyMessaged = excludeAlreadyMessaged || filters.excludeAlreadyMessaged === true;

  // Step 2: load the user's connections. We cap at 5k to keep scoring fast
  // in memory — scanning a larger list should move to SQL full-text later.
  const rows = await db
    .selectFrom("people")
    .select([
      "id", "first_name", "last_name", "company", "position", "linkedin_url",
      "email", "phone", "category", "industry",
    ])
    .where("user_id", "=", userId)
    .limit(5000)
    .execute();

  if (rows.length === 0) {
    return {
      kind: "text",
      content:
        "You don't have any connections loaded yet. Import your LinkedIn `Connections.csv` (Settings → CRM → Import) and try again.",
    };
  }

  // Step 3: score each row.
  //
  // Two paths. The PRIMARY path asks the LLM to classify each connection
  // semantically against the brief — this catches Goldman Sachs as
  // "banking" even though the company name doesn't contain the word
  // "bank", and "VP, Investment Banking Coverage" as banking even though
  // the position doesn't contain the literal industry term. The
  // FALLBACK is the legacy keyword scorer, used when the LLM call fails
  // or when the candidate pool is too large to sweep economically.
  //
  // Why LLM-first? Past bug: a brief like "people in banking" matched
  // only ~50 of the user's actual ~200 banking connections because the
  // keyword "banking" missed JPMorgan/Goldman/Morgan Stanley positions
  // that don't contain the literal word.
  type Scored = { row: typeof rows[number]; score: number; reasons: string[] };
  let scored: Scored[] = [];

  // Resolve the messaged-set early — we need it for the pre-filter
  // below so the LLM classifier doesn't burn tokens on people we'd drop.
  const messagedSet = await messagedSetPromise;

  // Pre-trim with the user's explicit company/role exclusions and the
  // messaged-set filter so the LLM classifier doesn't waste tokens on
  // people we'll drop anyway.
  let preFiltered = rows.filter((r) => {
    if (filters.excludeCompanies.some((kw) => matchField(r.company, kw))) return false;
    if (filters.excludeRoles.some((kw) => matchField(r.position, kw))) return false;
    return true;
  });
  if (excludeAlreadyMessaged && (messagedSet.names.size > 0 || messagedSet.linkedinUrls.size > 0)) {
    preFiltered = preFiltered.filter((r) => {
      const fullName = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim();
      return !hasMessaged(messagedSet, { name: fullName, linkedinUrl: r.linkedin_url });
    });
  }

  // Hard cap on LLM-classification cost — at most 2,500 connections per
  // query. Beyond that we fall back to keyword scoring (still works,
  // just less accurate). 2,500 × 1 LLM call per ~50 = 50 calls, ~3-5s
  // wallclock with parallelism, and a few cents in tokens.
  const LLM_CLASSIFY_LIMIT = 2500;
  const useLlmClassifier = preFiltered.length > 0 && preFiltered.length <= LLM_CLASSIFY_LIMIT;

  if (useLlmClassifier) {
    try {
      const classified = await classifyWithLlm({
        provider, brief: userInput, connections: preFiltered, userId, userKeys,
      });
      console.log(`[network] llm classifier: ${preFiltered.length} candidates → ${classified.filter((c) => c.match).length} matched`);
      const idToRow = new Map(preFiltered.map((r) => [r.id, r]));
      for (const c of classified) {
        if (!c.match) continue;
        const row = idToRow.get(c.id);
        if (!row) continue;
        const reasons = c.reason ? [c.reason] : [];
        // Map relevance (0-10) to the legacy score range so sorting + the
        // matchPct mapping below behave consistently.
        scored.push({ row, score: Math.max(1, c.relevance), reasons });
      }
    } catch (e) {
      console.warn("[network] llm classifier failed, falling back to keyword scorer:", (e as Error).message);
      scored = keywordScore(preFiltered, filters);
    }
  } else {
    if (preFiltered.length > LLM_CLASSIFY_LIMIT) {
      console.log(`[network] ${preFiltered.length} candidates exceeds LLM-classify limit (${LLM_CLASSIFY_LIMIT}); using keyword scorer`);
    }
    scored = keywordScore(preFiltered, filters);
  }

  // If everything was knocked out, degrade to a raw-token keyword match
  // so the user sees something instead of an empty result.
  if (scored.length === 0) {
    const tokens = tokenize(userInput);
    for (const r of preFiltered) {
      const hay = [r.position, r.company, r.category, r.industry]
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .join(" ")
        .toLowerCase();
      if (!hay) continue;
      let score = 0;
      for (const t of tokens) if (hay.includes(t)) score += 1;
      if (score > 0) scored.push({ row: r, score, reasons: [] });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // Funnel diagnostics. The messaged-set filter actually ran BEFORE
  // classification (during preFiltered above) so we don't waste LLM
  // tokens on people we'd drop anyway — but we still want the summary
  // to surface the math so the user can sanity-check unexpected counts.
  // To compute "how many would have matched the brief if we hadn't
  // filtered messaged out", we'd need to classify those too — too
  // expensive. Instead we report the pre-filter pool size as a proxy.
  const totalBeforeMessagedFilter = excludeAlreadyMessaged
    ? rows.filter((r) => {
        if (filters.excludeCompanies.some((kw) => matchField(r.company, kw))) return false;
        if (filters.excludeRoles.some((kw) => matchField(r.position, kw))) return false;
        return true;
      }).length
    : 0;
  const droppedAsMessaged = excludeAlreadyMessaged
    ? Math.max(0, totalBeforeMessagedFilter - preFiltered.length)
    : 0;

  // Dedup by normalized LinkedIn URL (primary) or name+company (fallback).
  // People reimport their connections.csv over time; without this the top
  // of the results is the same person listed twice with slightly different
  // positions.
  const seenLi = new Set<string>();
  const seenNameCo = new Set<string>();
  const deduped: typeof scored = [];
  for (const s of scored) {
    const li = normalizeLi(s.row.linkedin_url);
    if (li) {
      if (seenLi.has(li)) continue;
      seenLi.add(li);
    } else {
      const key = `${normName(s.row.first_name + " " + s.row.last_name)}|${(s.row.company ?? "").toLowerCase().trim()}`;
      if (seenNameCo.has(key)) continue;
      seenNameCo.add(key);
    }
    deduped.push(s);
  }

  // Analysis intent — user asked a question, not for a list. Write a short
  // textual take on their network in this area, quoting a few names
  // inline. Uses up to the top 40 scored rows as evidence.
  if (isAnalysis && deduped.length > 0) {
    const topForAnalysis = deduped.slice(0, 40);
    try {
      const out = await aiJson<{ analysis: string }>(
        provider,
        "You write a short, opinionated analysis of a user's LinkedIn network for a specific topic. 3-5 short paragraphs, HTML <p>/<strong>/<ul>/<li> only. Point out concentrations (which firms / seniorities dominate), gaps (what's missing), and 2-4 specific named contacts worth leading with. Be concrete — cite actual names and titles from the list. Skip the filler and don't repeat generic platitudes.",
        `Brief: ${userInput}\n\nTotal connections: ${rows.length}\n\nTop matches (from ${deduped.length}):\n${
          topForAnalysis
            .map((s, i) => `${i + 1}. ${s.row.first_name} ${s.row.last_name} — ${s.row.position ?? ""} @ ${s.row.company ?? ""}`)
            .join("\n")
        }\n\nReturn {"analysis": "<p>…</p>"}`,
        { maxTokens: 1200, userId, userKeys },
      );
      const html = (out.analysis ?? "").trim();
      if (html) return { kind: "text", content: html };
    } catch {
      // Fall through to the list below if the analysis pass fails.
    }
  }

  // How many to return. Default was a hard cap of 12 — way too low for a
  // "show me everyone in my network who matches" ask. Now:
  //   - "all" / "every" / "everyone" → return everything (capped at 500
  //     so the response stays a reasonable size).
  //   - explicit number ("top 25", "give me 50", a bare "100") → use that.
  //   - otherwise default to 50, which is a comfortable scroll without
  //     being pageful and still surfaces the long tail of matches.
  const requestedCount = extractNetworkCount(userInput);
  const desired = requestedCount === "all"
    ? Math.min(deduped.length, 500)
    : requestedCount ?? 50;
  const top = deduped.slice(0, desired);

  if (top.length === 0) {
    return {
      kind: "text",
      content:
        `No matches in your ${rows.length.toLocaleString()} connections for that brief. ` +
        `Try broader terms, or switch to web discovery.`,
    };
  }

  const maxScore = top[0]?.score ?? 1;
  const prospects: Prospect[] = top.map(({ row, score, reasons }) => {
    const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || "Unknown";
    const signals = reasons.slice(0, 2).map((text) => ({ kind: "match" as const, text, when: "your network" }));
    // Tag people the user has already messaged. Only adds the badge when
    // we're NOT filtering them out (in which case the list is implicitly
    // "haven't messaged yet" and the badge would be noise).
    if (!excludeAlreadyMessaged && hasMessaged(messagedSet, { name, linkedinUrl: row.linkedin_url })) {
      signals.unshift({ kind: "match" as const, text: "📨 You've messaged them before", when: "your messages" });
    }
    return {
      id: String(row.id),
      name,
      title: row.position ?? "",
      company: row.company ?? "",
      email: row.email ?? undefined,
      phone: row.phone ?? undefined,
      linkedin: row.linkedin_url ?? undefined,
      signals,
      past: [],
      matchPct: Math.max(50, Math.round((score / maxScore) * 100)),
    };
  });

  const truncated = deduped.length > top.length;
  const baseSummary = filters.notes
    ? `${prospects.length} match${prospects.length === 1 ? "" : "es"} in your network — ${filters.notes}`
    : `${prospects.length} match${prospects.length === 1 ? "" : "es"} in your ${rows.length.toLocaleString()} connections.`;
  // Show the funnel when the messaged-set filter dropped people. Lets the
  // user sanity-check unexpected counts ("only 3? but I have hundreds of
  // banking contacts!" — the funnel will show whether they were filtered
  // as messaged or simply didn't match the brief).
  const messagedSuffix = excludeAlreadyMessaged
    ? droppedAsMessaged > 0
      ? ` (${droppedAsMessaged.toLocaleString()} of your connections were excluded as already-messaged before classification ran)`
      : ` (no overlap with your ${messagedSet.names.size.toLocaleString()} sent-messages counterparts)`
    : "";
  const moreSuffix = truncated
    ? ` Showing the top ${top.length} of ${deduped.length.toLocaleString()} — say "show me all" or "top N" to see more.`
    : "";
  const summary = baseSummary + messagedSuffix + moreSuffix;

  return { kind: "prospects", summary, prospects };
}

/** Detects briefs like "find people in my network I haven't messaged yet"
 *  / "not yet contacted" / "no outreach" / "haven't reached out to". The
 *  match is intentionally permissive — false positives are cheap (a
 *  filter that drops nothing because the user has no messages logged) and
 *  false negatives are expensive (the user phrases it slightly off and
 *  the filter doesn't fire). */
function looksLikeHaventMessagedIntent(s: string): boolean {
  const hay = s.toLowerCase();
  return (
    /\b(?:hav(?:e\s+not|en'?t)|not(?:\s+yet)?|never)\s+(?:messaged|message|contacted|contact|reached?\s+out|spoken|talked|written|wrote|emailed|dm(?:ed|d)?|pinged|pitched)\b/.test(hay) ||
    /\bno\s+(?:outreach|message|contact|conversation|prior\s+contact|response|reply)\b/.test(hay) ||
    /\bnot\s+(?:in\s+touch|yet\s+spoken|yet\s+contacted|spoken\s+(?:to|with))\b/.test(hay) ||
    /\b(?:fresh|new|cold|untouched|unreached)\s+(?:contacts?|leads?|people|prospects?|targets?)\b/.test(hay) ||
    /\b(?:without|excluding|except)\s+(?:those\s+|the\s+|people\s+)?(?:i'?ve\s+)?(?:already\s+)?messaged\b/.test(hay)
  );
}

// ---- helpers ----

function normalize(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
    .filter((s) => s.length > 1 && s.length < 60)
    .slice(0, 8);
}

function matchField(field: string | null, kw: string): boolean {
  if (!field || !kw) return false;
  return field.toLowerCase().includes(kw);
}

/** Word-boundary match for single-word keywords; substring match for
 *  multi-word phrases. Prevents "banking" from hitting random compound
 *  tokens while still letting "investment banking" match anywhere. */
function matchFieldStrict(field: string | null, kw: string): boolean {
  if (!field || !kw) return false;
  const f = field.toLowerCase();
  if (kw.includes(" ")) return f.includes(kw);
  // Escape regex metacharacters (keywords come from an LLM, so trust is
  // zero — don't build a regex from raw input without escaping).
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}\\b`, "i").test(f);
}

/** Checks whether a brief is a question / analysis ask rather than a
 *  prospect-list ask. Network mode pivots to an LLM-written summary in
 *  that case so "what do you think of my banking network" returns prose
 *  instead of 12 name cards.
 *
 *  Past bug: a leading "who" / "what" used to flip this to true, so a
 *  filter query like "who within banking have I connected to but not
 *  messaged" got rendered as a 3-paragraph essay instead of a list.
 *  Now we only treat as analysis when the verb is explicitly analytic
 *  (describe / summarise / overview / analysis / what do you think) —
 *  "who" and "what" alone are too generic and almost always want a
 *  ranked list of names. */
function isAnalysisIntent(s: string): boolean {
  const hay = s.toLowerCase();
  // Explicit "give me prose" verbs at the start of the brief.
  if (/^\s*(?:describe|summari[sz]e|analy[sz]e|brief\s+me|give\s+me\s+(?:an?\s+)?(?:overview|summary|take|analysis|breakdown|read|sense)|tell\s+me\s+(?:about|how|whether)\b)/.test(hay)) return true;
  // "Overview / analysis / take of my X network" with a possessive.
  if (/\b(?:overview|summary|analysis|thoughts?|take|assessment|breakdown|landscape)\s+(?:of|on)\b/.test(hay) && /\b(?:my|our)\s+\w+\s+(?:network|connections?|contacts?|people|rolodex)\b/.test(hay)) return true;
  // "What do you think of …", "how strong/big is …" — opinion asks.
  if (/\b(?:what\s+do\s+you\s+think|how\s+(?:strong|weak|good|big|deep|broad)\s+is)\b/.test(hay)) return true;
  return false;
}

function normalizeLi(url: string | null | undefined): string {
  if (!url) return "";
  return url
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "");
}

function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 2 && !STOP.has(t))
    .slice(0, 12);
}

// Minimal stoplist — the brief is usually short, so we just strip filler.
const STOP = new Set([
  "the", "and", "for", "with", "who", "any", "are", "from", "that", "this",
  "find", "some", "show", "look", "people", "person", "network", "connection",
  "connections", "know", "knows", "have", "has", "want", "need", "would",
  "like", "love", "working", "work", "about", "into", "at", "in", "to", "of",
]);

// ---- LLM classifier --------------------------------------------------------
//
// Sends the candidate connections to the LLM in parallel batches and asks it
// to return {match, relevance, reason} for each. Way more accurate than
// keyword matching for category-style briefs ("people in banking", "AI
// leaders", "engineering managers"), because the LLM can reason about
// company-name → industry ("Goldman Sachs" → banking) and title → role
// family ("VP, Capital Markets Tech" → banking-tech) without us having to
// curate a knowledge base.

interface ClassifierRow {
  id: string;
  match: boolean;
  /** 1-10. 10 = perfect fit. Used to sort results and to compute matchPct. */
  relevance: number;
  reason: string;
}

interface NetworkRow {
  id: string;
  first_name: string;
  last_name: string;
  position: string | null;
  company: string | null;
  category: string | null;
  industry: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
}

async function classifyWithLlm(args: {
  provider: AiProvider;
  brief: string;
  connections: NetworkRow[];
  userId: string;
  userKeys?: UserKeys;
}): Promise<ClassifierRow[]> {
  const { provider, brief, connections, userId, userKeys } = args;
  // 50 per batch keeps each prompt under 3k input tokens (50 × ~30 tokens
  // for "Name | Title | Company") — well clear of any provider's limit and
  // small enough that one slow call doesn't dominate wallclock latency.
  const BATCH = 50;
  const batches: NetworkRow[][] = [];
  for (let i = 0; i < connections.length; i += BATCH) {
    batches.push(connections.slice(i, i + BATCH));
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      // Compact roster — LLM gets minimum tokens to make the decision.
      // Fields beyond name/title/company would mostly be empty for
      // LinkedIn-imported connections (no industry/category), so skip
      // them. Position is the most informative single field.
      const roster = batch.map((r) => ({
        id: r.id,
        n: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
        t: (r.position ?? "").slice(0, 200),
        c: (r.company ?? "").slice(0, 120),
      }));

      try {
        const out = await aiJson<{ matches: Array<{ id: string; m: boolean; r?: number; w?: string }> }>(
          provider,
          `You classify whether each LinkedIn connection in a roster matches a user's intent. Be GENEROUS but precise — the user wants comprehensive coverage of their network, not a 5-person shortlist.

DECISION RULE
- Use BOTH the company name and the title together. A title alone ("Director") tells you nothing; combined with a company ("Director at Goldman Sachs") it does.
- Apply real-world knowledge about firms. For example, when the brief says "banking" you should recognize JPMorgan, Goldman Sachs, Morgan Stanley, Citi, Wells Fargo, Barclays, Deutsche, Credit Suisse, HSBC, Lazard, Evercore, Houlihan Lokey, Stifel, Piper Sandler, Jefferies, Truist, KeyBank, etc. as banking firms even though their names don't contain the literal word "bank". Same logic for any other industry the user names.
- Apply common-sense title→role-family inference. "Investment Banking Coverage", "M&A Associate", "Capital Markets Director", "FIG MD" all qualify as banking even without the literal word.
- Reject only when the connection clearly doesn't fit. A junior data scientist at Stripe is not "banking" even if Stripe processes financial transactions.
- When unsure, MATCH (set m=true with a lower relevance score). The user has a "haven't messaged" filter and wants the broad slice.

OUTPUT
For each connection, return:
- id: the same id we gave you
- m: true if this person plausibly matches the brief, false otherwise
- r: relevance 1-10 (10 = exemplary fit, 5 = plausible but not central, 1 = barely)
- w: 4-10 word reason citing the specific signal (the company, the title phrase, etc.)

USER'S BRIEF (verbatim):
${brief}`,
          JSON.stringify(roster),
          { maxTokens: 4000, userId, userKeys },
        );
        const matches = Array.isArray(out.matches) ? out.matches : [];
        return matches.map((m) => ({
          id: String(m.id),
          match: m.m === true,
          relevance: typeof m.r === "number" ? Math.max(1, Math.min(10, Math.round(m.r))) : 5,
          reason: typeof m.w === "string" ? m.w.slice(0, 200) : "",
        }));
      } catch (e) {
        console.warn("[network] classifier batch failed:", (e as Error).message);
        // Fail-open per batch — return everyone in the batch as a low-
        // confidence match rather than dropping the whole batch silently.
        // The user can still triage; better than ghosting them.
        return batch.map((r) => ({
          id: r.id,
          match: true,
          relevance: 3,
          reason: "(classifier error — review manually)",
        }));
      }
    }),
  );

  return results.flat();
}

/** Legacy keyword scorer. Kept as the fallback when the LLM classifier
 *  errors out or the candidate pool is too large. Same scoring logic the
 *  module had before LLM classification was introduced. */
function keywordScore(rows: NetworkRow[], filters: Filters): Array<{ row: NetworkRow; score: number; reasons: string[] }> {
  const out: Array<{ row: NetworkRow; score: number; reasons: string[] }> = [];
  for (const r of rows) {
    const hay = [r.position, r.company, r.category, r.industry]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join(" | ")
      .toLowerCase();
    if (!hay) continue;
    let score = 0;
    const reasons: string[] = [];
    for (const kw of filters.roleKeywords) {
      if (matchFieldStrict(r.position, kw)) { score += 3; reasons.push(`role: ${kw}`); }
      else if (matchFieldStrict(hay, kw)) { score += 1; }
    }
    for (const kw of filters.companyKeywords) {
      if (matchFieldStrict(r.company, kw)) { score += 3; reasons.push(`company: ${kw}`); }
      else if (matchFieldStrict(hay, kw)) { score += 1; }
    }
    for (const kw of filters.industryKeywords) {
      if (matchFieldStrict(r.industry, kw) || matchFieldStrict(r.category, kw)) {
        score += 2; reasons.push(`industry: ${kw}`);
      } else if (matchFieldStrict(hay, kw)) { score += 1; }
    }
    if (score > 0 && r.position) {
      const pos = r.position.toLowerCase();
      if (/\b(chief|cxo|ceo|cto|cfo|coo|cro|cio|cdo|chair|founder|president|partner)\b/.test(pos)) score += 3;
      else if (/\b(managing director|md\b|head of|global head|group head|evp)\b/.test(pos)) score += 2;
      else if (/\b(director|vp|svp|vice president|principal|lead)\b/.test(pos)) score += 1;
      if (/\b(analyst|associate|intern|trainee|student|assistant|apprentice)\b/.test(pos)) score -= 2;
    }
    if (score > 0) out.push({ row: r, score, reasons });
  }
  return out;
}

/** Pick a result-count from the brief. Returns "all" for "all/every/everyone"
 *  phrasings, an integer for explicit counts ("top 25", "give me 50",
 *  "show 100"), or undefined for anything ambiguous (caller defaults to 50).
 *
 *  Conservative on bare digits: a number that's part of "tier 2" or a
 *  4-digit year shouldn't be treated as a count. */
function extractNetworkCount(s: string): number | "all" | undefined {
  const hay = s.toLowerCase();
  if (/\b(?:all|every(?:one|body)?|each)\s+(?:of\s+(?:the\s+|my\s+)?)?(?:people|person|matches?|connections?|contacts?|prospects?|results?|names?|the\s+ones)?\b/.test(hay)) return "all";
  if (/\b(?:show\s+me\s+(?:them\s+)?all|return\s+(?:them\s+)?all|list\s+(?:them\s+)?all|give\s+me\s+(?:them\s+)?all)\b/.test(hay)) return "all";
  // Strip patterns that look like counts but aren't ("tier 2", "Q3", years).
  const cleaned = hay
    .replace(/\btier\s*\d+\b/g, " ")
    .replace(/\bq[1-4]\b/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ");
  const m = cleaned.match(/\b(?:find|get|give|list|top|show|want|need|return)\s*(?:me\s+)?(?:up\s+to\s+)?(\d{1,3})\b/)
    ?? cleaned.match(/\b(\d{1,3})\s*(?:matches?|people|results?|connections?|contacts?|names?)\b/);
  if (!m) return undefined;
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, 500);
}

function assertLlmKey(provider: AiProvider, userKeys?: UserKeys) {
  const ok =
    provider === "openai" ? !!(userKeys?.openai ?? env.OPENAI_API_KEY) :
    provider === "anthropic" ? !!(userKeys?.anthropic ?? env.ANTHROPIC_API_KEY) :
    !!(userKeys?.deepseek ?? env.DEEPSEEK_API_KEY);
  if (!ok) throw new Error(`${provider.toUpperCase()} key missing — add it in Settings → API keys.`);
}
