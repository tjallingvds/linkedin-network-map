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

export function isTavilyQuotaError(e: unknown): e is TavilyQuotaError {
  return e instanceof TavilyQuotaError;
}
export function isTavilyAuthError(e: unknown): e is TavilyAuthError {
  return e instanceof TavilyAuthError;
}

export async function tavilySearch(
  query: string,
  opts: {
    maxResults?: number;
    depth?: "basic" | "advanced";
    includeDomains?: string[];
    userId?: string;
    userKeys?: UserKeys;
  } = {},
): Promise<TavilyResult[]> {
  const apiKey = opts.userKeys?.tavily ?? env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");
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
  const data = (await r.json()) as { results: TavilyResult[] };

  if (opts.userId) {
    await recordUsage({
      userId: opts.userId,
      provider: "tavily",
      kind: "search",
      credits: opts.depth === "advanced" ? 2 : 1,
      metadata: { query: query.slice(0, 120), byok },
    });
  }

  return data.results ?? [];
}
