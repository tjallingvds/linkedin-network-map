/**
 * Apollo.io integration.
 *
 * Docs: https://docs.apollo.io/
 *
 * Two endpoints we use:
 *   - POST /api/v1/mixed_people/search  — bulk prospecting by keywords/title/org
 *   - POST /api/v1/people/match         — deterministic enrichment by identity
 *
 * Note: Apollo's API returns a lot of fields — we normalize to a subset that
 * maps cleanly onto our Prospect shape.
 */
import { env } from "../env.js";
import { recordUsage } from "../usage/tracker.js";
import type { UserKeys } from "../ai/user-keys.js";

const BASE = "https://api.apollo.io/api/v1";

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * POST to Apollo with a hard per-call timeout and a couple of retries on
 * transient gateway errors (502/503/504) or network blips. Without the
 * timeout a hung Apollo request stalls the whole HTTP request until the
 * platform gateway kills it with a 502; without the retry a single transient
 * 502 fails an entire enrichment batch.
 */
async function apolloPost(path: string, apiKey: string, body: unknown): Promise<Response> {
  const MAX_ATTEMPTS = 3;
  const TIMEOUT_MS = 15_000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "X-Api-Key": apiKey,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if ((r.status === 502 || r.status === 503 || r.status === 504) && attempt < MAX_ATTEMPTS) {
        lastErr = new Error(`apollo ${r.status}`);
        await sleep(300 * attempt);
        continue;
      }
      return r;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) { await sleep(300 * attempt); continue; }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("apollo request failed");
}

export function apolloConfigured(userKeys?: UserKeys): boolean {
  return !!(userKeys?.apollo ?? env.APOLLO_API_KEY);
}

/** Raw Apollo person shape (subset we care about). */
export interface ApolloPerson {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  email?: string | null;
  email_status?: string;
  phone_numbers?: { raw_number?: string; sanitized_number?: string }[];
  linkedin_url?: string;
  city?: string;
  state?: string;
  country?: string;
  organization?: {
    name?: string;
    website_url?: string;
    estimated_num_employees?: number;
    industry?: string;
    keywords?: string[];
    latest_funding_round_date?: string;
    total_funding?: number;
    founded_year?: number;
  };
  employment_history?: { organization_name?: string; title?: string; start_date?: string; end_date?: string }[];
  photo_url?: string;
}

interface ApolloSearchResponse {
  people?: ApolloPerson[];
  pagination?: { total_entries?: number };
}

interface ApolloMatchResponse {
  person?: ApolloPerson;
}

/** People search — keyword + title + org filters. */
export async function apolloPeopleSearch(params: {
  q?: string;
  company?: string;
  title?: string;
  page?: number;
  userId?: string;
  userKeys?: UserKeys;
}): Promise<{ people: ApolloPerson[]; total: number }> {
  const apiKey = params.userKeys?.apollo ?? env.APOLLO_API_KEY;
  if (!apiKey) throw new Error("APOLLO_API_KEY not set");
  const byok = !!params.userKeys?.apollo;

  const r = await apolloPost("/mixed_people/search", apiKey, {
    q_keywords: params.q,
    organization_name: params.company,
    person_titles: params.title ? [params.title] : undefined,
    page: params.page ?? 1,
    per_page: 25,
  });
  if (!r.ok) throw new Error(`apollo search ${r.status}: ${await r.text()}`);
  const data = (await r.json()) as ApolloSearchResponse;
  if (params.userId) {
    await recordUsage({ userId: params.userId, provider: "apollo", kind: "people_search", credits: 1, metadata: { byok } });
  }
  return { people: data.people ?? [], total: data.pagination?.total_entries ?? 0 };
}

/**
 * Match a single person by identity. Apollo requires at least one strong
 * identifier (email, LinkedIn URL, or name + org).
 */
export async function apolloMatchPerson(params: {
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  domain?: string;
  organizationName?: string;
  linkedinUrl?: string;
  userId?: string;
  userKeys?: UserKeys;
}): Promise<ApolloPerson | null> {
  const apiKey = params.userKeys?.apollo ?? env.APOLLO_API_KEY;
  if (!apiKey) throw new Error("APOLLO_API_KEY not set");
  const byok = !!params.userKeys?.apollo;

  const body: Record<string, unknown> = { reveal_personal_emails: false };
  if (params.firstName) body.first_name = params.firstName;
  if (params.lastName) body.last_name = params.lastName;
  if (params.name) body.name = params.name;
  if (params.email) body.email = params.email;
  if (params.domain) body.domain = params.domain;
  if (params.organizationName) body.organization_name = params.organizationName;
  if (params.linkedinUrl) body.linkedin_url = params.linkedinUrl;

  const r = await apolloPost("/people/match", apiKey, body);
  if (!r.ok) {
    if (r.status === 404) return null;
    throw new Error(`apollo match ${r.status}: ${await r.text()}`);
  }
  const data = (await r.json()) as ApolloMatchResponse;
  if (params.userId) {
    await recordUsage({ userId: params.userId, provider: "apollo", kind: "match", credits: 1, metadata: { byok } });
  }
  return data.person ?? null;
}

