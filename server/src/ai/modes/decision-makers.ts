/**
 * Decision-maker / buying-committee mapping.
 *
 * Triggered when the user writes something like:
 *   "I want to sell <X> to <Company>, map the decision makers"
 *   "Who should I pitch <X> to at <Company>"
 *   "decision makers at <Company> for <X>"
 *
 * The flow (all LLM-orchestrated, Tavily for the web reads):
 *   1. Parse the brief into {product, company, value_prop}.
 *   2. LLM proposes 8-12 role queries tailored to the product + company
 *      (e.g. selling AI-ops → CIO, CTO, Head of Automation, COO, Head of
 *      Transformation, Chief Data Officer, VP Engineering …).
 *   3. Fire one advanced LinkedIn-scoped Tavily search per role, in
 *      parallel. Dedup by URL.
 *   4. Extract the people who actually work *at* the company from the
 *      snippets (hard current-employer rule).
 *   5. LLM assigns each person a buying-committee role (Economic buyer /
 *      Champion / Technical evaluator / User / Influencer / Gatekeeper)
 *      and writes a short narrative describing likely relationships —
 *      who probably reports to whom, who you should approach first, who
 *      has budget authority, who might block.
 *   6. Return a prospects CompletionResult whose `summary` holds the
 *      narrative (rendered as HTML by DiscoverPage's existing ai-summary
 *      block) and whose per-prospect signals carry the committee role +
 *      relationship notes.
 */
import type { AiProvider, CompletionResult, Prospect, ProspectSignal } from "@app/shared";
import { env } from "../../env.js";
import { aiJson } from "../json.js";
import { tavilySearch, type TavilyResult } from "../tavily.js";
import type { UserKeys } from "../user-keys.js";

interface ParsedBuyingBrief {
  /** Target company (the buyer). */
  company: string;
  /** What the user is selling, 1 line. */
  product: string;
  /** The value prop / why this matters to the buyer, 1-2 lines. */
  valueProp?: string;
  /** Optional geography hint (e.g. "US headquarters", "EMEA"). */
  geography?: string;
}

interface Candidate {
  name: string;
  title: string;
  company: string;
  linkedin?: string;
  source?: string;
}

type CommitteeRole =
  | "economic_buyer"
  | "champion"
  | "technical_evaluator"
  | "user"
  | "influencer"
  | "gatekeeper"
  | "unknown";

interface CommitteeAssignment {
  /** Matches the prospect.id set below. */
  id: string;
  role: CommitteeRole;
  /** One-line note on what this person owns / likely cares about. */
  why: string;
  /** Free-form "reports to / works with" note. */
  relationship?: string;
}

/** Triggers returning a decision-maker map instead of a raw find. */
export function looksLikeDecisionMakerMap(s: string): boolean {
  const hay = s.toLowerCase();
  // "sell ... to ...", "pitch ... to ...", "map decision makers", "buying
  // committee", "who should I sell/pitch", "decision makers at ...".
  const intent =
    /\b(?:sell(?:ing)?|pitch(?:ing)?)\b[\s\S]{0,80}\b(?:to|at)\b/.test(hay) ||
    /\b(?:decision[-\s]?makers?|buying\s+committee|buyer\s+map|who\s+decides|org\s+chart|leadership\s+map|stakeholders?)\b/.test(hay) ||
    /\bmap(?:\s+out)?\b[\s\S]{0,40}\b(?:decision|leaders?|stakeholders?|committee)\b/.test(hay);
  // Must also reference at least one company-ish proper noun.
  const hasProperNoun = /\b[A-Z][a-zA-Z&.]{2,}(?:\s+[A-Z][a-zA-Z&.]+)*\b/.test(s);
  return intent && hasProperNoun;
}

export async function runDecisionMakers(
  provider: AiProvider,
  userInput: string,
  userId: string,
  userKeys?: UserKeys,
): Promise<CompletionResult | null> {
  assertKeys(provider, userKeys);

  // 1. Parse the brief.
  const parsed = await parseBuyingBrief(provider, userInput, userId, userKeys);
  if (!parsed || !parsed.company) {
    console.warn("[decision-makers] could not parse company from brief");
    return null;
  }
  console.log(
    `[decision-makers] company="${parsed.company}" product="${parsed.product || "(unspecified)"}"`,
  );

  // 2. LLM proposes role queries tuned to the product + company.
  const roleQueries = await proposeRoleQueries(provider, parsed, userId, userKeys);
  if (roleQueries.length === 0) return null;

  // 3. Parallel LinkedIn-scoped searches.
  const searchResults = await Promise.all(
    roleQueries.map(async (q) => {
      try {
        const linked = await tavilySearch(q, {
          depth: "advanced",
          maxResults: 6,
          includeDomains: ["linkedin.com"],
          userId,
          userKeys,
        });
        if (linked.length > 0) return linked;
        return await tavilySearch(`${q} LinkedIn`, {
          depth: "advanced",
          maxResults: 6,
          userId,
          userKeys,
        });
      } catch {
        return [] as TavilyResult[];
      }
    }),
  );
  const flat = searchResults.flat();
  const seenUrls = new Set<string>();
  const unique: TavilyResult[] = [];
  for (const r of flat) {
    if (!r.url || seenUrls.has(r.url)) continue;
    seenUrls.add(r.url);
    unique.push(r);
  }
  console.log(
    `[decision-makers] ${roleQueries.length} queries → ${flat.length} raw → ${unique.length} unique URLs`,
  );

  if (unique.length === 0) {
    return {
      kind: "text",
      content: `Couldn't surface any public LinkedIn leadership profiles for ${parsed.company}. The company may be private / small, or the domain may block web search.`,
    };
  }

  // 4. Extract candidates — hard current-employer rule.
  const context = unique
    .slice(0, 40)
    .map((r) => `[${r.title}] (${r.url})\n${r.content ?? ""}`)
    .join("\n\n---\n\n");
  const extracted = await extractCandidates(provider, context, parsed.company, userId, userKeys);

  // Dedup by name, then filter to people at the target company.
  const byName = new Map<string, Candidate>();
  for (const c of extracted) {
    if (!c.name || !c.company) continue;
    const key = c.name.toLowerCase().trim();
    if (!byName.has(key)) byName.set(key, c);
  }
  const wantCompany = parsed.company.toLowerCase();
  const atCompany = Array.from(byName.values()).filter((c) =>
    c.company.toLowerCase().includes(wantCompany.split(/\s+/)[0] ?? wantCompany),
  );

  if (atCompany.length === 0) {
    return {
      kind: "text",
      content: `No public leadership profiles at ${parsed.company} came back from the web. Try naming a business unit or product line.`,
    };
  }

  // 5. Assign committee roles + write the narrative.
  const preliminary: Prospect[] = atCompany.slice(0, 14).map((c, i) => ({
    id: `dm${Date.now()}-${i}`,
    name: c.name,
    title: c.title,
    company: c.company,
    linkedin: normalizeLinkedInUrl(c.linkedin),
    signals: [],
    past: [],
    matchPct: 80,
  }));

  const { assignments, narrativeHtml } = await buildCommitteeMap(
    provider,
    parsed,
    preliminary,
    userId,
    userKeys,
  );

  // 6. Merge assignments back into the prospects. Prefer committee-role order
  //    so the list reads top-down from "approach first" to "loop in later".
  const roleOrder: Record<CommitteeRole, number> = {
    economic_buyer: 0,
    champion: 1,
    technical_evaluator: 2,
    user: 3,
    influencer: 4,
    gatekeeper: 5,
    unknown: 6,
  };
  const prospects: Prospect[] = preliminary.map((p) => {
    const a = assignments.find((x) => x.id === p.id);
    const signals: ProspectSignal[] = [];
    const role = a?.role ?? "unknown";
    signals.push({ kind: "match", text: `Committee role: ${prettyRole(role)}`, when: "" });
    if (a?.why) signals.push({ kind: "match", text: a.why, when: "" });
    if (a?.relationship) signals.push({ kind: "match", text: a.relationship, when: "" });
    return { ...p, signals };
  });
  prospects.sort((a, b) => {
    const ra = roleOrder[roleFromSignal(a) ?? "unknown"];
    const rb = roleOrder[roleFromSignal(b) ?? "unknown"];
    return ra - rb;
  });

  return {
    kind: "prospects",
    summary: narrativeHtml,
    prospects,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function parseBuyingBrief(
  provider: AiProvider,
  brief: string,
  userId: string,
  userKeys?: UserKeys,
): Promise<ParsedBuyingBrief | null> {
  try {
    const out = await aiJson<ParsedBuyingBrief>(
      provider,
      `You parse a B2B sales brief into a buyer-side target. Return JSON:

{
  "company": "the COMPANY the user wants to sell INTO (their buyer)",
  "product": "1-line description of what the user is selling",
  "valueProp": "why the buyer would care (1-2 lines)",
  "geography": "optional region hint"
}

Rules:
- "company" is the PROSPECT's employer, not the user's company.
- If the brief doesn't name a company, return {"company": ""}.
- Keep "product" concrete (e.g. "AI back-office automation platform" not "our solution").
- Return ONLY the JSON object.`,
      brief,
      { maxTokens: 400, userId, userKeys },
    );
    if (!out || typeof out.company !== "string" || !out.company.trim()) return null;
    return {
      company: out.company.trim(),
      product: (out.product ?? "").trim(),
      valueProp: (out.valueProp ?? "").trim() || undefined,
      geography: (out.geography ?? "").trim() || undefined,
    };
  } catch (e) {
    console.warn("[decision-makers] parseBuyingBrief failed:", (e as Error).message);
    return null;
  }
}

async function proposeRoleQueries(
  provider: AiProvider,
  parsed: ParsedBuyingBrief,
  userId: string,
  userKeys?: UserKeys,
): Promise<string[]> {
  try {
    const out = await aiJson<{ queries: string[] }>(
      provider,
      `You pick the 8-12 LinkedIn search queries most likely to surface the BUYING COMMITTEE for this deal. Think like an account executive: who signs the cheque, who champions, who integrates, who blocks?

Context:
- Seller is pitching: ${parsed.product || "(unspecified)"}
- Buyer company: ${parsed.company}
${parsed.valueProp ? `- Value prop: ${parsed.valueProp}\n` : ""}${parsed.geography ? `- Geography hint: ${parsed.geography}\n` : ""}

RULES
- Each query MUST contain the company name verbatim.
- Each query names ONE specific title or short phrase (e.g. "Chief Operating Officer", "Head of AI", "Head of Automation", "VP Operations", "Chief Data Officer").
- Mix seniority: include 2-3 C-suite, 3-5 Head-of / VP, 1-2 specialist roles unique to the product area.
- Include the roles most relevant to ${parsed.product || "this product"} first, followed by the general buying-committee roles.
- Do NOT repeat the same title twice.

Return {"queries": [...]} — 8 to 12 strings.`,
      JSON.stringify(parsed),
      { maxTokens: 800, userId, userKeys },
    );
    const qs = (out.queries ?? [])
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .map((q) => q.trim())
      .slice(0, 12);
    if (qs.length >= 4) return qs;
    // Fallback if the model returned nothing sensible.
    return [
      `Chief Executive Officer ${parsed.company}`,
      `Chief Operating Officer ${parsed.company}`,
      `Chief Information Officer ${parsed.company}`,
      `Chief Technology Officer ${parsed.company}`,
      `Head of AI ${parsed.company}`,
      `Head of Automation ${parsed.company}`,
      `Head of Transformation ${parsed.company}`,
      `VP Operations ${parsed.company}`,
    ];
  } catch (e) {
    console.warn("[decision-makers] proposeRoleQueries failed:", (e as Error).message);
    return [];
  }
}

async function extractCandidates(
  provider: AiProvider,
  context: string,
  company: string,
  userId: string,
  userKeys?: UserKeys,
): Promise<Candidate[]> {
  try {
    const out = await aiJson<{ candidates: Candidate[] }>(
      provider,
      `You extract executives and decision-makers currently at "${company}" from LinkedIn snippets.

HARD RULES
- "company" MUST be the person's CURRENT employer (the most recent Experience entry). Skip anyone who only mentions ${company} in a prior role, recommendation, or client list.
- Return only real individuals — skip article authors, commenters, and aggregated "team" listings.
- Full names only. No initials.
- Prefer linkedin.com/in/ URLs.
- Skip Analysts and Associates; keep Managers and above.

Return {"candidates": [...]} — up to 20 items:
{"name":"Full Name","title":"Current Title","company":"Current Employer","linkedin":"linkedin.com/in/…","source":"URL"}`,
      context,
      { maxTokens: 3500, userId, userKeys },
    );
    return (out.candidates ?? []).filter((c) => c && c.name && c.title && c.company);
  } catch (e) {
    console.warn("[decision-makers] extractCandidates failed:", (e as Error).message);
    return [];
  }
}

async function buildCommitteeMap(
  provider: AiProvider,
  parsed: ParsedBuyingBrief,
  prospects: Prospect[],
  userId: string,
  userKeys?: UserKeys,
): Promise<{ assignments: CommitteeAssignment[]; narrativeHtml: string }> {
  const roster = prospects.map((p) => ({ id: p.id, name: p.name, title: p.title }));
  try {
    const out = await aiJson<{
      assignments: CommitteeAssignment[];
      narrative: string;
    }>(
      provider,
      `You are an experienced enterprise AE mapping the buying committee at "${parsed.company}" for a seller pitching:
  ${parsed.product || "(unspecified product)"}
  ${parsed.valueProp ? `Value prop: ${parsed.valueProp}` : ""}

You receive a ROSTER of executives currently at that company. For EACH person, assign:
- role: one of "economic_buyer" | "champion" | "technical_evaluator" | "user" | "influencer" | "gatekeeper" | "unknown"
- why: one-line reason they matter for THIS deal (referencing their title and the product)
- relationship: one line describing who they likely report to / collaborate with inside the roster, if clear. If unclear, set "".

Then write a SHORT narrative (3-5 short paragraphs, HTML allowed — use <p> tags, optional <strong>):
  <p>Who to approach first and why.</p>
  <p>Who controls budget / signs the contract.</p>
  <p>Who could block and how.</p>
  <p>How the relevant people likely relate — reporting chains, cross-functional ties.</p>

ROSTER:
${JSON.stringify(roster, null, 2)}

Return:
{
  "assignments": [{"id":"...","role":"...","why":"...","relationship":"..."}, ...],
  "narrative": "<p>...</p><p>...</p>"
}`,
      `Selling ${parsed.product} into ${parsed.company}. ${parsed.valueProp ?? ""}`,
      { maxTokens: 3000, userId, userKeys },
    );
    const assignments = Array.isArray(out.assignments) ? out.assignments : [];
    const narrativeHtml = typeof out.narrative === "string" ? sanitizeNarrative(out.narrative) : "";
    return {
      assignments,
      narrativeHtml:
        narrativeHtml ||
        `<p>Mapped ${prospects.length} decision-makers at ${escapeHtml(parsed.company)} relevant to <strong>${escapeHtml(parsed.product || "this deal")}</strong>.</p>`,
    };
  } catch (e) {
    console.warn("[decision-makers] buildCommitteeMap failed:", (e as Error).message);
    return {
      assignments: [],
      narrativeHtml: `<p>Mapped ${prospects.length} decision-makers at ${escapeHtml(parsed.company)}. Committee-role breakdown unavailable this run — the AI narrative pass failed.</p>`,
    };
  }
}

function prettyRole(r: CommitteeRole): string {
  switch (r) {
    case "economic_buyer": return "Economic buyer";
    case "champion": return "Champion";
    case "technical_evaluator": return "Technical evaluator";
    case "user": return "End user";
    case "influencer": return "Influencer";
    case "gatekeeper": return "Gatekeeper";
    default: return "Unclassified";
  }
}

function roleFromSignal(p: Prospect): CommitteeRole | null {
  const s = p.signals.find((x) => x.text.startsWith("Committee role: "));
  if (!s) return null;
  const label = s.text.replace("Committee role: ", "").toLowerCase();
  if (label.startsWith("economic")) return "economic_buyer";
  if (label.startsWith("champion")) return "champion";
  if (label.startsWith("technical")) return "technical_evaluator";
  if (label.startsWith("end user") || label === "user") return "user";
  if (label.startsWith("influencer")) return "influencer";
  if (label.startsWith("gatekeeper")) return "gatekeeper";
  return "unknown";
}

/** Whitelist a tiny subset of HTML so LLM output can structure the narrative
 *  but can't inject script / style / onclick handlers into the chat bubble. */
function sanitizeNarrative(html: string): string {
  const allowedTags = /^(p|strong|em|ul|li|br)$/i;
  return html
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (match, tag: string) => {
      if (!allowedTags.test(tag)) return "";
      // Strip any attributes.
      return match.startsWith("</") ? `</${tag.toLowerCase()}>` : `<${tag.toLowerCase()}>`;
    })
    .trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeLinkedInUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(www\.)?linkedin\.com\//i.test(trimmed)) return `https://${trimmed.replace(/^www\./i, "")}`;
  if (/^\/?in\//i.test(trimmed)) return `https://linkedin.com/${trimmed.replace(/^\//, "")}`;
  return undefined;
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
