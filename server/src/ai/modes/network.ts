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
): Promise<CompletionResult> {
  assertLlmKey(provider);

  // Step 1: decompose the brief into typed filters.
  let filters: Filters = EMPTY_FILTERS;
  try {
    const raw = await aiJson<Partial<Filters>>(
      provider,
      "You convert a prospecting brief into structured filters for searching a local LinkedIn connections table. Be concise: 1-4 keywords per bucket, lowercase.",
      `Brief: ${userInput}\n\nReturn {"roleKeywords": [...], "companyKeywords": [...], "industryKeywords": [...], "excludeCompanies": [...], "excludeRoles": [...], "notes": "<one line>"}.\nOnly include values explicitly implied. Empty arrays are fine.`,
      { maxTokens: 400, userId },
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
      if (matchField(r.position, kw)) { score += 3; reasons.push(`role: ${kw}`); }
      else if (hay.includes(kw)) { score += 1; }
    }
    for (const kw of filters.companyKeywords) {
      if (matchField(r.company, kw)) { score += 3; reasons.push(`company: ${kw}`); }
      else if (hay.includes(kw)) { score += 1; }
    }
    for (const kw of filters.industryKeywords) {
      if (matchField(r.industry, kw) || matchField(r.category, kw)) {
        score += 2; reasons.push(`industry: ${kw}`);
      } else if (hay.includes(kw)) { score += 1; }
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
  const top = scored.slice(0, 12);

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

function assertLlmKey(provider: AiProvider) {
  const ok =
    provider === "openai" ? !!env.OPENAI_API_KEY :
    provider === "anthropic" ? !!env.ANTHROPIC_API_KEY :
    !!env.DEEPSEEK_API_KEY;
  if (!ok) throw new Error(`${provider.toUpperCase()}_API_KEY not set — configure it in server .env.`);
}
