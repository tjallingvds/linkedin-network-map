/**
 * Looking a person up before writing their line.
 *
 * Only ever the LinkedIn profile stored on the contact in the CRM. Not a
 * profile found by searching their name, not the open web, not a best guess.
 *
 * The reason is the failure it prevents: "Sasha Lim, Head of Data" matches
 * several real people, and a line written from the wrong Sasha Lim reads as
 * perfectly confident and is completely false. A name search can't tell them
 * apart, so it isn't offered. A contact with no LinkedIn link in the CRM
 * simply has no web facts, and their line comes from the CRM notes alone — or
 * they're skipped, which is the right outcome for a thin record.
 */
import { tavilySearch } from "../../../ai/tavily.js";

/**
 * The profile page is passed on whole — no content limit. It is one page about
 * one person, read once, and deciding in advance which half of someone's
 * profile matters is exactly the judgement this feature exists to avoid making
 * badly. Raw content costs no extra Tavily credits; the cost is input tokens
 * on a single model call per contact.
 *
 * The number below is not a content decision. It is a last-resort guard so a
 * pathological page cannot overflow the model's context and turn "a slightly
 * shorter profile" into "no line at all" — which is the worse outcome. A full
 * LinkedIn profile extracts to roughly 5–15k characters, so this is an order
 * of magnitude clear of anything real.
 */
const SAFETY_CEILING = 200_000;
import type { UserKeys } from "../../../ai/user-keys.js";

/**
 * Reduce a LinkedIn URL to the part that identifies the person, so the same
 * profile written different ways compares equal:
 *
 *   https://www.linkedin.com/in/sasha-lim-1a2b3/   →  in/sasha-lim-1a2b3
 *   linkedin.com/in/sasha-lim-1a2b3?trk=abc        →  in/sasha-lim-1a2b3
 *   https://nl.linkedin.com/in/Sasha-Lim-1a2b3     →  in/sasha-lim-1a2b3
 *
 * Returns null for anything that isn't a LinkedIn profile URL.
 */
export function profileKey(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  // Tolerate a full URL with any subdomain, a bare domain, or a bare path.
  const m = s.match(/(?:^|\/\/)(?:[a-z0-9-]+\.)*linkedin\.com\/(.+)$/)
    ?? s.match(/^\/?((?:in|pub|company)\/.+)$/);
  if (!m) return null;
  const path = m[1]!
    .split(/[?#]/)[0]!       // drop query and fragment
    .replace(/^\/+|\/+$/g, "");
  if (!/^(in|pub|company)\//.test(path)) return null;
  // Keep only the identifying segment: in/<slug>, not in/<slug>/details/…
  const parts = path.split("/");
  return parts.length >= 2 && parts[1] ? `${parts[0]}/${parts[1]}` : null;
}

/**
 * Find the person's LinkedIn profile wherever it is on the contact.
 *
 * The built-in `linkedin` column is only one of the places it lands: a board
 * can have its own column for it, and imports often put it in a custom field.
 * Reading only the built-in one meant contacts that plainly had a profile were
 * reported as "no LinkedIn link on this contact", which is both wrong and
 * impossible to argue with. So every field is considered, and anything that
 * parses as a profile URL counts — the shape is the test, not the column name.
 */
export function findProfileUrl(c: {
  linkedin?: string | null;
  linkedin_url?: string | null;
  custom_fields?: unknown;
}): string | null {
  const candidates: string[] = [];
  const add = (v: unknown) => { if (typeof v === "string" && v.trim()) candidates.push(v.trim()); };

  add(c.linkedin);
  add(c.linkedin_url);
  const custom = (c.custom_fields ?? {}) as Record<string, unknown>;
  // Prefer a field that says what it is, then fall back to any field whose
  // value looks like a profile.
  for (const [k, v] of Object.entries(custom)) {
    if (/linked\s*in|profile|li[\s_-]?url/i.test(k)) add(v);
  }
  for (const v of Object.values(custom)) add(v);

  return candidates.find((v) => profileKey(v) !== null) ?? null;
}

/** Is this search result the profile we asked for, rather than someone else's? */
export function isSameProfile(resultUrl: string | undefined, wanted: string): boolean {
  const got = profileKey(resultUrl);
  return !!got && got === wanted;
}

export async function research(
  c: {
    name: string; company: string | null; title: string | null;
    linkedin: string | null; custom_fields?: unknown;
  },
  userId: string,
  userKeys?: UserKeys,
): Promise<{ snippets: { title: string; url: string; content: string }[]; note: string }> {
  const url = findProfileUrl(c);
  const wanted = profileKey(url);
  if (!wanted) {
    const anythingThere = (c.linkedin ?? "").trim()
      || Object.values((c.custom_fields ?? {}) as Record<string, unknown>)
        .some((v) => typeof v === "string" && /linkedin/i.test(v));
    return {
      snippets: [],
      note: anythingThere
        ? "the LinkedIn link on this contact isn't a profile URL"
        : "no LinkedIn link on this contact",
    };
  }

  try {
    const results = await tavilySearch(url!, {
      depth: "advanced", maxResults: 5, includeDomains: ["linkedin.com"],
      // The whole page, not the one-line snippet. A profile's substance — the
      // About section, what they actually run, how they describe it — is never
      // in the snippet, and that substance is the only thing a truthful
      // opening line can be built from. Raw content costs no extra credits.
      rawContent: true, rawContentChars: 0, // 0 = don't truncate

      userId, userKeys,
    });

    // Tavily answers a URL query with whatever it finds relevant, which
    // includes other people's profiles. Keep only this exact one.
    const mine = results
      .filter((r) => isSameProfile(r.url, wanted))
      .map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        // Prefer the page text; fall back to the snippet when LinkedIn served
        // us nothing crawlable.
        content: (r.rawContent?.trim() || r.content?.trim() || "").slice(0, SAFETY_CEILING),
      }))
      .filter((r) => r.content.length > 40)
      .slice(0, 2);

    if (mine.length) return { snippets: mine, note: "LinkedIn" };
    // LinkedIn blocks most crawling, so an empty result is ordinary. There is
    // deliberately no fallback search: someone else's page is worse than none.
    return { snippets: [], note: "their LinkedIn page couldn't be read" };
  } catch (err) {
    // A missing Tavily key or a provider blip must not fail the whole run —
    // the line falls back to whatever the CRM already knows.
    console.warn(`[openers] research skipped for ${c.name}: ${(err as Error).message}`);
    return { snippets: [], note: "lookup unavailable" };
  }
}
