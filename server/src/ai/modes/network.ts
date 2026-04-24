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

interface Filters {
  roleKeywords: string[];       // e.g. ["vp engineering", "cto", "head of ai"]
  companyKeywords: string[];    // e.g. ["stripe", "openai"]
  industryKeywords: string[];   // e.g. ["fintech", "ai"]
  excludeCompanies: string[];   // e.g. ["google"] when user says "not at google"
  excludeRoles: string[];       // seniority/role exclusions
  notes: string;                // short free-text about the intent
}

const EMPTY_FILTERS: Filters = {
  roleKeywords: [], companyKeywords: [], industryKeywords: [],
  excludeCompanies: [], excludeRoles: [], notes: "",
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

  // Step 1: decompose the brief into typed filters.
  let filters: Filters = EMPTY_FILTERS;
  try {
    const raw = await aiJson<Partial<Filters>>(
      provider,
      "You convert a prospecting brief into structured filters for searching a local LinkedIn connections table. Be concise: 1-4 keywords per bucket, lowercase. Prefer MULTI-WORD role keywords over single words — 'investment banking' beats 'banking' because it won't match company names or unrelated roles.",
      `Brief: ${userInput}\n\nReturn {"roleKeywords": [...], "companyKeywords": [...], "industryKeywords": [...], "excludeCompanies": [...], "excludeRoles": [...], "notes": "<one line>"}.\nOnly include values explicitly implied. Empty arrays are fine.`,
      { maxTokens: 400, userId, userKeys },
    );
    filters = {
      roleKeywords: normalize(raw.roleKeywords),
      companyKeywords: normalize(raw.companyKeywords),
      industryKeywords: normalize(raw.industryKeywords),
      excludeCompanies: normalize(raw.excludeCompanies),
      excludeRoles: normalize(raw.excludeRoles),
      notes: typeof raw.notes === "string" ? raw.notes.slice(0, 240) : "",
    };
  } catch {
    // If the LLM decomposition fails, fall back to a raw-text search over the
    // whole input. The scoring below tokenizes the input as a single bucket.
    filters = { ...EMPTY_FILTERS, roleKeywords: tokenize(userInput) };
  }

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

  // Step 3: score each row against the filters.
  type Scored = { row: typeof rows[number]; score: number; reasons: string[] };
  const scored: Scored[] = [];
  for (const r of rows) {
    const hay = [r.position, r.company, r.category, r.industry]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join(" | ")
      .toLowerCase();
    if (!hay) continue;

    // Exclusions short-circuit.
    if (filters.excludeCompanies.some((kw) => matchField(r.company, kw))) continue;
    if (filters.excludeRoles.some((kw) => matchField(r.position, kw))) continue;

    let score = 0;
    const reasons: string[] = [];
    for (const kw of filters.roleKeywords) {
      // Position match gets the biggest boost. For single-word keywords
      // ("banking"), use word-boundary matching so we don't tag every
      // company that happens to contain the word ("GoDutch banking") as
      // a role hit. Multi-word keywords ("investment banking") are
      // already specific enough to use plain substring.
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
    // Seniority weighting — a Head of / MD / Chief / Director / VP match is
    // what the user almost always wants in a network-analysis question,
    // not Analysts and Associates. Previously the top of the results was
    // being padded with juniors whose title happened to contain the same
    // keyword (e.g. "Analyst, Investment Banking").
    if (score > 0 && r.position) {
      const pos = r.position.toLowerCase();
      if (/\b(chief|cxo|ceo|cto|cfo|coo|cro|cio|cdo|chair|founder|president|partner)\b/.test(pos)) score += 3;
      else if (/\b(managing director|md\b|head of|global head|group head|evp)\b/.test(pos)) score += 2;
      else if (/\b(director|vp|svp|vice president|principal|lead)\b/.test(pos)) score += 1;
      if (/\b(analyst|associate|intern|trainee|student|assistant|apprentice)\b/.test(pos)) score -= 2;
    }
    if (score > 0) scored.push({ row: r, score, reasons });
  }

  // If strict filters knocked out everything, degrade to a raw-token match so
  // the user sees *something* rather than an empty result.
  if (scored.length === 0) {
    const tokens = tokenize(userInput);
    for (const r of rows) {
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

  const top = deduped.slice(0, 12);

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
    return {
      id: String(row.id),
      name,
      title: row.position ?? "",
      company: row.company ?? "",
      email: row.email ?? undefined,
      phone: row.phone ?? undefined,
      linkedin: row.linkedin_url ?? undefined,
      signals: reasons.slice(0, 2).map((text) => ({ kind: "match", text, when: "your network" })),
      past: [],
      matchPct: Math.max(50, Math.round((score / maxScore) * 100)),
    };
  });

  const summary =
    filters.notes
      ? `${prospects.length} match${prospects.length === 1 ? "" : "es"} in your network — ${filters.notes}`
      : `${prospects.length} match${prospects.length === 1 ? "" : "es"} in your ${rows.length.toLocaleString()} connections.`;

  return { kind: "prospects", summary, prospects };
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
 *  instead of 12 name cards. */
function isAnalysisIntent(s: string): boolean {
  const hay = s.toLowerCase();
  if (/^\s*(?:what|how|who|why|describe|tell\s+me|summari[sz]e|give\s+me\s+(?:an?\s+)?(?:overview|summary|take|analysis))/.test(hay)) return true;
  if (/\b(?:overview|summary|analysis|thoughts?|take|assessment|breakdown|landscape)\b/.test(hay) && /\b(?:my|our)\s+\w+\s+(?:network|connections?|contacts?|people|rolodex)\b/.test(hay)) return true;
  if (/\b(?:what\s+do\s+you\s+think|how\s+(?:strong|weak|good|big)\s+is)\b/.test(hay)) return true;
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

function assertLlmKey(provider: AiProvider, userKeys?: UserKeys) {
  const ok =
    provider === "openai" ? !!(userKeys?.openai ?? env.OPENAI_API_KEY) :
    provider === "anthropic" ? !!(userKeys?.anthropic ?? env.ANTHROPIC_API_KEY) :
    !!(userKeys?.deepseek ?? env.DEEPSEEK_API_KEY);
  if (!ok) throw new Error(`${provider.toUpperCase()} key missing — add it in Settings → API keys.`);
}
