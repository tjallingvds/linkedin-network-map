/**
 * Person background research — chat counterpart of the CRM board
 * "Find backgrounds" button. Triggered when the user asks for a deep dive
 * on a specific named person:
 *   "tell me everything about Francois Buet-Golfouse at Barclays"
 *   "background on Jane Doe"
 *   "deep dive on Maya Okafor"
 *   "what do you know about X"
 *
 * Unlike runNameLookup (which ranks plausible *who is this* matches) and
 * runDecisionMakers (which maps a buying committee), this branch assumes
 * the target is identified and pulls concrete, non-obvious colour:
 *   - recent posts, talks, interviews, panels
 *   - notable opinions, quirky anecdotes, products shipped
 *   - each fact cited inline with a markdown link to the source URL
 *
 * Returns { kind: "text", content: HTML } so the narrative renders in the
 * ai-summary block (same surface as decision-maker maps).
 */
import type { AiProvider, CompletionResult } from "@app/shared";
import { env } from "../../env.js";
import { aiJson } from "../json.js";
import { tavilySearch, type TavilyResult, isTavilyQuotaError, isTavilyAuthError } from "../tavily.js";
import type { UserKeys } from "../user-keys.js";

interface ParsedTarget {
  name: string;
  company?: string;
  /** e.g. "AI/ML for global markets" — pulled from the brief if the user
   *  offered role colour. Used to boost LinkedIn vs. general-web relevance. */
  roleHint?: string;
}

/** Trigger condition. The user is asking for a deep research pass on a
 *  person who has already been identified (either earlier in the chat or
 *  named directly in the latest turn). Typo-tolerant — users routinely
 *  type "everyting" / "finde out" / "whatever you can". */
export function looksLikePersonBackground(s: string): boolean {
  const hay = s.toLowerCase();
  // Keyword-style triggers — any one of these + a name triggers the branch.
  const deepDiveIntent =
    // "background" / "deep dive" / "research" — direct.
    /\b(?:background|deep[-\s]?dive|research)\b/.test(hay) ||
    // "tell me everything/more/all/whatever" (typo-tolerant on everything).
    /\btell\s+me\s+(?:every[a-z]{3,6}|more|all|whatever|what\s+you\s+(?:can|know))\b/.test(hay) ||
    // "find out everything/anything/stuff/whatever [you can]" about/on.
    /\bfind(?:e)?\s+(?:out\s+)?(?:every[a-z]{3,6}|any[a-z]{3,6}|stuff|whatever|all|what(?:ever)?)\b/.test(hay) ||
    // "what do you know / what can you find / what can you tell" about/on.
    /\bwhat\s+(?:do\s+you\s+know|can\s+you\s+(?:find|tell|dig))\b/.test(hay) ||
    // "whatever you (can) find/tell/know/dig" — common paraphrase.
    /\bwhatever\s+(?:you\s+(?:can|could)\s+)?(?:find|tell|know|dig)\b/.test(hay) ||
    // "everything/anything you can find/know/tell" about/on.
    /\b(?:every[a-z]{3,6}|any[a-z]{3,6})\s+(?:you\s+can\s+)?(?:find|tell|know|dig)\b/.test(hay) ||
    // "know more" / "learn more" / "dig into" about/on.
    /\b(?:know|learn)\s+more\b|\bdig\s+(?:into|up)\b/.test(hay) ||
    // "who is …" (but not pronouns — those are follow-ups with no name).
    /\bwho\s+is\s+(?!he\b|she\b|they\b|that\b|this\b)/.test(hay) ||
    // Artefact-specific signals — user is asking for colour, not another list.
    /\b(?:recent\s+posts?|talks?|interviews?|opinions?|podcasts?|panels?|papers?)\b/.test(hay);

  // Require a proper name somewhere (first+last, or a single proper noun
  // if preceded by "about/on/for"). Keeps it from firing on generic
  // "what do you know about banks" style briefs.
  const hasName =
    /\b[A-Z][a-z]+(?:-[A-Z][a-z]+)?\s+[A-Z][a-zA-Z-]+\b/.test(s) ||
    /\b(?:about|on|for)\s+[A-Z][a-zA-Z-]+(?:\s+[A-Z][a-zA-Z-]+)+\b/.test(s);
  return deepDiveIntent && hasName;
}

export async function runPersonBackground(args: {
  provider: AiProvider;
  brief: string;
  userId: string;
  userKeys?: UserKeys;
}): Promise<CompletionResult | null> {
  const { provider, brief, userId, userKeys } = args;
  assertKeys(provider, userKeys);

  // 1. LLM parses the target. Uses the WHOLE brief so "his background, the
  // dude at barclays" works when the name was named in an earlier turn.
  const target = await parseTarget(provider, brief, userId, userKeys);
  if (!target || !target.name) {
    console.warn("[person-bg] could not identify target from brief");
    return null;
  }
  console.log(
    `[person-bg] target="${target.name}" company="${target.company ?? "(unspecified)"}"`,
  );

  // 2. Run several complementary Tavily searches in parallel. Different
  // queries surface different sources — a person's own posts vs. articles
  // about them vs. conference bios rarely overlap much.
  const queries = buildQueries(target);
  const searchResults = await Promise.all(
    queries.map(async (q) => {
      try {
        return await tavilySearch(q, {
          depth: "advanced",
          maxResults: 6,
          userId,
          userKeys,
        });
      } catch (e) {
        if (isTavilyQuotaError(e) || isTavilyAuthError(e)) throw e;
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
    `[person-bg] ${queries.length} queries → ${flat.length} raw → ${unique.length} unique URLs`,
  );

  if (unique.length === 0) {
    return {
      kind: "text",
      content: `Couldn't find public material on ${target.name}${target.company ? ` at ${target.company}` : ""}. They may keep a low online profile — try adding a team / product / paper title, or check a specific speaker-bio page.`,
    };
  }

  // 3. LLM writes the background brief from the snippets. Output is HTML so
  // the ai-summary block renders with proper paragraph spacing and
  // clickable citations.
  const context = unique
    .slice(0, 30)
    .map((r) => `[${r.title}](${r.url})\n${(r.content ?? "").slice(0, 1800)}`)
    .join("\n\n---\n\n");
  try {
    const out = await aiJson<{ background: string }>(
      provider,
      `You write a deep, concrete, citation-heavy research brief about a SPECIFIC person for a sales / BD / recruiting user. The user has identified the target and wants the non-obvious colour.

Target: ${target.name}${target.company ? ` at ${target.company}` : ""}${target.roleHint ? ` (${target.roleHint})` : ""}

WHAT TO PULL from the search snippets (in rough priority order):
  • Recent public posts, talks, podcasts, papers, interviews — cite each.
  • Notable opinions or takes they've shared in public.
  • Products / programmes / research they've shipped or led.
  • Prior roles and career trajectory (if visible in sources).
  • Non-work signals: hobbies, causes, universities, public side projects.
  • Anything quirky or specific — the user wants colour, not generic bio lines.

STRICT RULES
  - EVERY specific fact gets an inline markdown link — [quoted phrase or short label](url) — pointing at the source. No claim without a citation.
  - Never invent facts not grounded in the snippets. If the snippets are thin, say so in one honest sentence.
  - Skip platitudes ("seasoned leader", "passionate about innovation"). If a sentence could describe anyone in their job title, cut it.
  - Return HTML: <p> paragraphs, <strong> for section headers, <ul><li> for bulleted lists. No <h1>-<h6> tags. No inline styles.
  - Max ~1200 characters of prose; cite 4-8 distinct sources.

Return {"background": "<p>…</p><p><strong>…</strong></p><ul><li>…</li></ul>"}`,
      `Brief:\n${brief}\n\nSearch results:\n${context}`,
      { maxTokens: 2500, userId, userKeys },
    );
    const html = sanitizeHtml(out.background?.trim() ?? "");
    if (!html) {
      return {
        kind: "text",
        content: `Found sources for ${target.name} but couldn't synthesize a brief. Try asking again or narrowing to a specific angle (e.g. "recent talks", "papers published", "what they've said about AI").`,
      };
    }
    return { kind: "text", content: html };
  } catch (err) {
    console.error("[person-bg] synthesis failed:", (err as Error).message);
    return null;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function parseTarget(
  provider: AiProvider,
  brief: string,
  userId: string,
  userKeys?: UserKeys,
): Promise<ParsedTarget | null> {
  try {
    const out = await aiJson<ParsedTarget>(
      provider,
      `You extract a research target from a user brief that may reference them by name, pronoun, or nickname. The brief may be multi-turn — pronouns refer to the most recently named person.

Return {"name": "Full Name", "company": "Employer (optional)", "roleHint": "short role summary (optional)"}

If the brief never names a person (only pronouns like "him"/"her" with no antecedent in the text), return {"name": ""}.
Return ONLY the JSON object.`,
      brief,
      { maxTokens: 250, userId, userKeys },
    );
    if (!out || typeof out.name !== "string" || !out.name.trim()) return null;
    return {
      name: out.name.trim(),
      company: (out.company ?? "").trim() || undefined,
      roleHint: (out.roleHint ?? "").trim() || undefined,
    };
  } catch (e) {
    console.warn("[person-bg] parseTarget failed:", (e as Error).message);
    return null;
  }
}

function buildQueries(t: ParsedTarget): string[] {
  const base = t.company ? `"${t.name}" "${t.company}"` : `"${t.name}"`;
  const bareName = `"${t.name}"`;
  const qs = [
    base,
    `${base} talk OR interview OR podcast OR panel`,
    `${base} post OR article OR blog`,
    `${bareName} paper OR research OR publication`,
    `${bareName} keynote OR conference OR speaker`,
  ];
  if (t.roleHint) qs.push(`${base} ${t.roleHint}`);
  return qs;
}

/** Whitelist a small set of tags so the LLM-generated brief can structure
 *  itself but can't inject <script>, <style>, or event handlers into the
 *  chat bubble. Inline markdown links are already HTML by the time they
 *  get here. */
function sanitizeHtml(html: string): string {
  const allowed = /^(p|strong|em|ul|ol|li|br|a)$/i;
  // Strip disallowed tags entirely; for allowed tags, preserve href on <a>
  // and drop every other attribute.
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, tag: string, attrs: string) => {
    const tagLc = tag.toLowerCase();
    if (!allowed.test(tagLc)) return "";
    if (match.startsWith("</")) return `</${tagLc}>`;
    if (tagLc === "a") {
      const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const raw = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "";
      const href = /^https?:\/\//i.test(raw) ? raw : "";
      return href ? `<a href="${escapeAttr(href)}" target="_blank" rel="noreferrer">` : "<a>";
    }
    return `<${tagLc}>`;
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
