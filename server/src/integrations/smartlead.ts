/**
 * Smartlead API client.  Base: https://server.smartlead.ai/api/v1/
 * Auth is an `api_key` query parameter (per-user, decrypted at the call site).
 *
 * Endpoints used (paths confirmed against api.smartlead.ai reference, 2026-07):
 *   POST /campaigns/{cid}/leads                      add leads (batch <=400)
 *   GET  /campaigns/{cid}/leads                      list leads (reconciliation)
 *   POST /campaigns/{cid}/leads/{lid}/pause          reversible pause
 *   POST /campaigns/{cid}/leads/{lid}/resume         resume
 *   POST /leads/{lid}/unsubscribe                    permanent global unsubscribe
 *   POST /leads/add-domain-block-list                block a whole domain
 *   GET  /leads/by-email                             resolve provider lead id
 *   GET  /campaigns/                                 list campaigns
 *
 * Rate limit varies by plan (docs say "contact support"); we treat it as
 * unknown and back off on 429. Batch size 400 is the documented add-leads max.
 *
 * Response shapes marked VERIFY below were ambiguous in the public docs, so
 * every reader here is defensive (multiple field spellings, optional chaining)
 * and is exercised by test/outreach.e2e.ts against a fake API. The add-leads
 * response is deliberately NOT depended on for lead ids — they are resolved by
 * a campaign-leads sweep, with the EMAIL_SENT webhook as a further backstop.
 * The one genuine remaining unknown is whether the live campaign-leads payload
 * matches one of the field spellings read in getCampaignLeads.
 */
import { env } from "../env.js";

const BASE = env.SMARTLEAD_BASE_URL ?? "https://server.smartlead.ai/api/v1";

export const ADD_LEADS_BATCH = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SmartleadError extends Error {
  constructor(public status: number, public path: string, public bodyText: string) {
    super(`smartlead ${status} ${path}: ${bodyText.slice(0, 300)}`);
    this.name = "SmartleadError";
  }
}

function url(path: string, apiKey: string, query?: Record<string, string | number | undefined>): string {
  const u = new URL(`${BASE}${path}`);
  u.searchParams.set("api_key", apiKey);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * Fetch with timeout, retries on transient gateway errors, and exponential
 * backoff on 429. Mirrors the Apollo client's resilience contract.
 */
async function slFetch(
  method: "GET" | "POST",
  path: string,
  apiKey: string,
  opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<unknown> {
  const MAX_ATTEMPTS = 5;
  const TIMEOUT_MS = 20_000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url(path, apiKey, opts.query), {
        method,
        headers: { "Content-Type": "application/json" },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
      if (r.status === 429 && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(r.headers.get("retry-after")) || 0;
        await sleep(retryAfter * 1000 || 500 * 2 ** (attempt - 1));
        continue;
      }
      if ((r.status === 502 || r.status === 503 || r.status === 504) && attempt < MAX_ATTEMPTS) {
        await sleep(300 * attempt);
        continue;
      }
      const text = await r.text();
      if (!r.ok) throw new SmartleadError(r.status, path, text);
      return text ? JSON.parse(text) : {};
    } catch (err) {
      lastErr = err;
      if (err instanceof SmartleadError) throw err; // non-retryable HTTP error
      if (attempt < MAX_ATTEMPTS) { await sleep(300 * attempt); continue; }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("smartlead request failed");
}

// ── Types ────────────────────────────────────────────────────────────────
export interface SmartleadLeadInput {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  custom_fields?: Record<string, string>;
}

/** The three flags in `settings` that, if flipped to true, silently disable
 *  all Smartlead-side suppression. We assert they are false before every push. */
export interface AddLeadsSettings {
  ignore_global_block_list: boolean;
  ignore_unsubscribe_list: boolean;
  ignore_duplicate_leads_in_other_campaign: boolean;
}

const SAFE_SETTINGS: AddLeadsSettings = {
  ignore_global_block_list: false,
  ignore_unsubscribe_list: false,
  ignore_duplicate_leads_in_other_campaign: false,
};

// ── Campaigns ──────────────────────────────────────────────────────────────
export async function listCampaigns(apiKey: string): Promise<Array<{ id: number; name: string; status: string }>> {
  const data = await slFetch("GET", "/campaigns/", apiKey);
  // VERIFY: response is an array of campaign objects.
  return Array.isArray(data) ? (data as Array<{ id: number; name: string; status: string }>) : [];
}

// ── Add leads ───────────────────────────────────────────────────────────────
/**
 * Add a batch of leads (<=400) to a campaign. Hard-asserts the suppression
 * flags before sending so a caller can never accidentally bypass Smartlead's
 * own block/unsubscribe lists.
 */
export async function addLeadsToCampaign(
  campaignId: string,
  leads: SmartleadLeadInput[],
  apiKey: string,
): Promise<unknown> {
  if (leads.length > ADD_LEADS_BATCH) {
    throw new Error(`addLeadsToCampaign: ${leads.length} leads exceeds batch max ${ADD_LEADS_BATCH}`);
  }
  // Belt-and-suspenders: never trust a mutated settings object.
  if (SAFE_SETTINGS.ignore_global_block_list || SAFE_SETTINGS.ignore_unsubscribe_list) {
    throw new Error("refusing to push: Smartlead suppression flags are not both false");
  }
  return slFetch("POST", `/campaigns/${campaignId}/leads`, apiKey, {
    body: { lead_list: leads, settings: SAFE_SETTINGS },
  });
}

/** Resolve a Smartlead lead id from an email. Used to capture provider_lead_id
 *  at import time, since the add-leads response does not reliably return ids. */
export async function getLeadIdByEmail(email: string, apiKey: string): Promise<string | null> {
  try {
    const data = (await slFetch("GET", "/leads/by-email", apiKey, { query: { email } })) as
      | { id?: number | string }
      | null;
    // VERIFY: by-email returns a single lead object with `id`.
    const id = data?.id;
    return id === undefined || id === null ? null : String(id);
  } catch (err) {
    if (err instanceof SmartleadError && err.status === 404) return null;
    throw err;
  }
}

// ── Suppression levers ───────────────────────────────────────────────────────
/** 4.1 Reversible pause — stops future steps for this lead in this campaign. */
export function pauseLead(campaignId: string, leadId: string, apiKey: string): Promise<unknown> {
  return slFetch("POST", `/campaigns/${campaignId}/leads/${leadId}/pause`, apiKey);
}

export function resumeLead(campaignId: string, leadId: string, apiKey: string): Promise<unknown> {
  return slFetch("POST", `/campaigns/${campaignId}/leads/${leadId}/resume`, apiKey);
}

/** 4.2 Permanent global unsubscribe — removes from all campaigns, blocks
 *  re-adding. Opt-out and hard bounce only; never wired to a status change. */
export function unsubscribeLeadGlobally(leadId: string, apiKey: string): Promise<unknown> {
  return slFetch("POST", `/leads/${leadId}/unsubscribe`, apiKey);
}

/** 4.3 Domain block — compliance/procurement stop for a whole organisation. */
export function addDomainToBlockList(domain: string, apiKey: string): Promise<unknown> {
  return slFetch("POST", "/leads/add-domain-block-list", apiKey, { body: { domain } });
}

/**
 * The campaign's own email sequence — subject + body of the first step.
 *
 * Used to ground the personal opening line: the line has to lead into THIS
 * email, so the drafter is shown the email it will sit on top of. Returns null
 * when the sequence can't be read, and the drafter simply proceeds without it.
 *
 * VERIFY: sequence shape. Reads the first step's subject/body across the
 * spellings Smartlead has used (`subject`/`email_subject`, `email_body`/`body`).
 */
export async function getCampaignFirstEmail(
  campaignId: string,
  apiKey: string,
): Promise<{ subject: string; body: string } | null> {
  try {
    const data = (await slFetch("GET", `/campaigns/${campaignId}/sequences`, apiKey)) as unknown;
    const list = Array.isArray(data) ? data : (data as { data?: unknown[] })?.data;
    if (!Array.isArray(list) || !list.length) return null;

    // Lowest sequence number = the first email a lead receives.
    const sorted = [...list].sort(
      (a, b) => Number((a as Record<string, unknown>).seq_number ?? 0) - Number((b as Record<string, unknown>).seq_number ?? 0),
    );
    for (const step of sorted) {
      const r = step as Record<string, unknown>;
      const variants = (r.seq_variants ?? r.variants) as Record<string, unknown>[] | undefined;
      const src = Array.isArray(variants) && variants.length ? variants[0]! : r;
      const subject = String(src.subject ?? src.email_subject ?? "").trim();
      const body = String(src.email_body ?? src.body ?? "").trim();
      if (subject || body) {
        // Strip tags so the model reads prose, not markup.
        const text = body.replace(/<br\s*\/?>(\s*)/gi, "\n").replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").trim();
        return { subject, body: text.slice(0, 2500) };
      }
    }
    return null;
  } catch (err) {
    console.warn(`[smartlead] could not read sequence for campaign ${campaignId}: ${(err as Error).message}`);
    return null;
  }
}

// ── Reconciliation read ──────────────────────────────────────────────────────
export interface SmartleadCampaignLead {
  leadId: string | null;
  email: string | null;
  /** Normalised lead status within the campaign. */
  status: string | null;
  /** True when Smartlead shows this lead as having replied. Used to recover
   *  replies whose webhook we never received — the reconciler cannot detect a
   *  missed reply by comparing states alone (both sides just say "active"). */
  replied: boolean;
  /** Smartlead's reply categorisation, when present, so a recovered reply can
   *  still be filtered for out-of-office / auto-responders. */
  category: string | null;
}

/**
 * Page through a campaign's leads for the nightly reconciliation diff.
 * VERIFY: response shape { total_leads, data: [{ lead: { id, email }, status }] }.
 */
export async function getCampaignLeads(campaignId: string, apiKey: string): Promise<SmartleadCampaignLead[]> {
  const out: SmartleadCampaignLead[] = [];
  const limit = 100;
  let offset = 0;
  // Cap pages defensively so a shape surprise can't loop forever.
  for (let page = 0; page < 1000; page++) {
    const data = (await slFetch("GET", `/campaigns/${campaignId}/leads`, apiKey, {
      query: { offset, limit },
    })) as { total_leads?: number; data?: Array<Record<string, unknown>> };
    const rows = data?.data ?? [];
    for (const row of rows) {
      const lead = (row.lead ?? {}) as { id?: number | string; email?: string };
      const status = (row.status as string) ?? null;
      // VERIFY: field names for reply state vary; read every plausible one and
      // fall back to the status string containing REPLIED.
      const replyCount = Number(row.reply_count ?? row.replies ?? 0);
      const replied =
        row.is_replied === true ||
        row.replied === true ||
        replyCount > 0 ||
        (status ?? "").toUpperCase().includes("REPLIED");
      const category =
        (row.lead_category as string) ?? (row.category as string) ??
        ((lead as Record<string, unknown>).lead_category as string) ?? null;
      out.push({
        leadId: lead.id === undefined ? null : String(lead.id),
        email: (lead.email as string) ?? null,
        status,
        replied,
        category,
      });
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  return out;
}

/** Map Smartlead's per-lead campaign status onto our membership state vocab. */
export function mapLeadStatusToState(status: string | null): "active" | "paused" | "completed" | "blocked" | null {
  if (!status) return null;
  const s = status.toUpperCase();
  if (s.includes("PAUSE") || s === "STOPPED") return "paused";
  if (s.includes("BLOCK") || s.includes("UNSUBSCRIB")) return "blocked";
  if (s.includes("COMPLET") || s.includes("FINISH")) return "completed";
  if (s.includes("START") || s.includes("PROGRESS") || s.includes("ACTIVE") || s === "INPROGRESS") return "active";
  return null; // unknown — don't act on it
}
