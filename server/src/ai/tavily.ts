/**
 * Tavily web search — server-side. Records a usage event per call.
 */
import { env } from "../env.js";
import { recordUsage } from "../usage/tracker.js";
import type { UserKeys } from "./user-keys.js";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  /** Full page text — only present when the call passes rawContent: true.
   *  A directory / "top N" / leadership page has many people in here that the
   *  short `content` snippet never mentions, so the extractor mines this when
   *  present. Capped by the caller to keep token cost bounded. */
  rawContent?: string;
  score?: number;
}

/** Thrown when Tavily rejects the call because the account is out of credits
 *  / over the monthly cap. Distinguished from a transient failure so callers
 *  can surface it to the user instead of silently returning an empty list. */
export class TavilyQuotaError extends Error {
  readonly kind = "tavily_quota" as const;
  readonly byok: boolean;
  constructor(message: string, byok: boolean) {
    super(message);
    this.name = "TavilyQuotaError";
    this.byok = byok;
  }
}

/** Thrown when Tavily rejects the API key as invalid / revoked. */
export class TavilyAuthError extends Error {
  readonly kind = "tavily_auth" as const;
  readonly byok: boolean;
  constructor(message: string, byok: boolean) {
    super(message);
    this.name = "TavilyAuthError";
    this.byok = byok;
  }
}

/** Thrown when no Tavily key is configured at all — neither a per-user
 *  (BYOK) key nor a workspace env key. Distinct from auth (a key that
 *  exists but is rejected) so the user gets "add a key" rather than
 *  "your key was rejected" — and, critically, so a missing key never
 *  masquerades as "the search found nothing." */
export class TavilyKeyMissingError extends Error {
  readonly kind = "tavily_missing" as const;
  constructor() {
    super("No Tavily API key configured (neither a per-user key nor TAVILY_API_KEY).");
    this.name = "TavilyKeyMissingError";
  }
}

/** Thrown when EVERY web-search query failed for a non-quota/non-auth
 *  reason (transient 5xx, timeout, network). Distinct from "the search
 *  ran and legitimately returned zero results" so the user is told the
 *  search failed rather than that their firms are "too obscure." */
export class WebSearchFailedError extends Error {
  readonly kind = "web_search_failed" as const;
  /** The first underlying error message, for the diagnostic card + logs. */
  readonly reason: string;
  constructor(reason: string) {
    super(`All web-search queries failed: ${reason}`);
    this.name = "WebSearchFailedError";
    this.reason = reason;
  }
}

export function isTavilyQuotaError(e: unknown): e is TavilyQuotaError {
  return e instanceof TavilyQuotaError;
}
export function isTavilyAuthError(e: unknown): e is TavilyAuthError {
  return e instanceof TavilyAuthError;
}
export function isTavilyKeyMissingError(e: unknown): e is TavilyKeyMissingError {
  return e instanceof TavilyKeyMissingError;
}
export function isWebSearchFailedError(e: unknown): e is WebSearchFailedError {
  return e instanceof WebSearchFailedError;
}

/** True when a Tavily key is resolvable for this request (BYOK or env).
 *  Lets callers fail fast with a clear message before spending LLM tokens
 *  generating queries they can never run. */
export function hasTavilyKey(userKeys?: UserKeys): boolean {
  return !!(userKeys?.tavily ?? env.TAVILY_API_KEY);
}

export async function tavilySearch(
  query: string,
  opts: {
    maxResults?: number;
    depth?: "basic" | "advanced";
    includeDomains?: string[];
    /** Ask Tavily for each result's full page text (`raw_content`). Costs the
     *  same credits; use for breadth passes that mine dense list pages. */
    rawContent?: boolean;
    /** How much of that page text to keep. The default suits the extractor,
     *  which batches ~40 results into one LLM call. Pass 0 for no truncation
     *  when reading a single page for a single person. */
    rawContentChars?: number;
    userId?: string;
    userKeys?: UserKeys;
  } = {},
): Promise<TavilyResult[]> {
  const apiKey = opts.userKeys?.tavily ?? env.TAVILY_API_KEY;
  if (!apiKey) throw new TavilyKeyMissingError();
  const byok = !!opts.userKeys?.tavily;

  const body: Record<string, unknown> = {
    api_key: apiKey,
    query,
    search_depth: opts.depth ?? "basic",
    max_results: opts.maxResults ?? 5,
    include_answer: false,
  };
  if (opts.includeDomains && opts.includeDomains.length > 0) {
    body.include_domains = opts.includeDomains;
  }
  if (opts.rawContent) {
    body.include_raw_content = true;
  }

  // Hard timeout — without this, a hung Tavily request sits forever while
  // the chat route's heartbeat keeps TCP alive, and eventually the cloud
  // proxy's request cap kills the entire server process ("Failed to fetch"
  // on the client, no useful error in the logs).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let r: Response;
  try {
    r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === "AbortError") {
      throw new Error(`tavily timed out after 30s: ${query.slice(0, 80)}`);
    }
    throw err;
  }
  clearTimeout(timeout);
  if (!r.ok) {
    const text = await r.text();
    // Tavily returns 432 for "you've used all your monthly credits" and 429
    // for rate limit; auth failures come back as 401/403. Their error body
    // is JSON {"detail":"..."} or {"error":"..."} or plain text — sniff for
    // the keywords either way so we don't miss a phrasing tweak from them.
    const lower = text.toLowerCase();
    const looksLikeQuota =
      r.status === 432 ||
      r.status === 429 ||
      r.status === 402 ||
      lower.includes("usage limit") ||
      lower.includes("monthly limit") ||
      lower.includes("credit") ||
      lower.includes("quota") ||
      lower.includes("plan limit") ||
      lower.includes("exceeded") ||
      lower.includes("out of credits");
    const looksLikeAuth =
      r.status === 401 ||
      r.status === 403 ||
      lower.includes("invalid api key") ||
      lower.includes("invalid_api_key") ||
      lower.includes("unauthorized") ||
      lower.includes("authentication");
    if (looksLikeQuota) {
      throw new TavilyQuotaError(
        `tavily quota exhausted (HTTP ${r.status}): ${text.slice(0, 200)}`,
        byok,
      );
    }
    if (looksLikeAuth) {
      throw new TavilyAuthError(
        `tavily auth failed (HTTP ${r.status}): ${text.slice(0, 200)}`,
        byok,
      );
    }
    throw new Error(`tavily ${r.status}: ${text}`);
  }
  const data = (await r.json()) as {
    results: Array<TavilyResult & { raw_content?: string }>;
  };

  if (opts.userId) {
    await recordUsage({
      userId: opts.userId,
      provider: "tavily",
      kind: "search",
      credits: opts.depth === "advanced" ? 2 : 1,
      metadata: { query: query.slice(0, 120), byok },
    });
  }

  return (data.results ?? []).map((x) => ({
    title: x.title,
    url: x.url,
    content: x.content,
    score: x.score,
    // Tavily returns snake_case raw_content; normalise + cap. Kept modest
    // because the extractor batches ~40 results per LLM call — at 2.5k chars
    // each that's ~25k tokens/call (safe for smaller models), while still
    // being 5-10× the snippet so dense pages surface their full roster.
    rawContent: x.raw_content
      ? (opts.rawContentChars === 0 ? x.raw_content : x.raw_content.slice(0, opts.rawContentChars ?? 2500))
      : undefined,
  }));
}
