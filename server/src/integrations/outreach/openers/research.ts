/**
 * Looking a person up on the web before writing their line.
 */
import { tavilySearch } from "../../../ai/tavily.js";
import type { UserKeys } from "../../../ai/user-keys.js";

/**
 * Look the person up on the web — LinkedIn first, then anything public.
 *
 * LinkedIn blocks most crawling, so the profile pass frequently returns
 * nothing; that's expected, not an error. We fall back to a general search on
 * name + company, and if BOTH come back empty we simply have no web facts and
 * the line falls back to whatever the CRM holds (or is skipped entirely).
 * Nothing here is ever inferred — only text actually returned is passed on.
 */
export async function research(
  c: { name: string; company: string | null; title: string | null; linkedin: string | null },
  userId: string,
  userKeys?: UserKeys,
): Promise<{ snippets: { title: string; url: string; content: string }[]; note: string }> {
  const who = [`"${c.name}"`, c.company ? `"${c.company}"` : "", c.title ?? ""].filter(Boolean).join(" ");
  if (!c.name.trim()) return { snippets: [], note: "no name to search" };

  const take = (rs: { title?: string; url?: string; content?: string }[]) =>
    rs.filter((r) => (r.content ?? "").trim().length > 40)
      .slice(0, 4)
      .map((r) => ({ title: r.title ?? "", url: r.url ?? "", content: (r.content ?? "").slice(0, 1200) }));

  try {
    // 1. The person's own LinkedIn, when it's reachable.
    const q = c.linkedin ? `${c.linkedin} ${c.name}` : who;
    let out = take(await tavilySearch(q, {
      depth: "advanced", maxResults: 5, includeDomains: ["linkedin.com"], userId, userKeys,
    }));
    if (out.length) return { snippets: out, note: "LinkedIn" };

    // 2. LinkedIn blocked or nothing indexed — try the open web.
    out = take(await tavilySearch(who, { depth: "advanced", maxResults: 5, userId, userKeys }));
    if (out.length) return { snippets: out, note: "web search" };

    return { snippets: [], note: "nothing found online" };
  } catch (err) {
    // A missing Tavily key or a provider blip must not fail the whole run —
    // we just fall back to whatever the CRM already knows.
    console.warn(`[openers] research skipped for ${c.name}: ${(err as Error).message}`);
    return { snippets: [], note: "lookup unavailable" };
  }
}

