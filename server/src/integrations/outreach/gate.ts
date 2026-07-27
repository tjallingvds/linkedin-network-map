/**
 * Export gate (spec §5). Nothing reaches Smartlead except through this filter.
 *
 * Eligible = a CRM contact that is in a content tier, has an email, is not
 * suppressed (by email or by domain, subdomains included), and is not already
 * sitting in a live campaign. There is no manual-CSV path into Smartlead — this
 * is the only door.
 */
import { db } from "../../db/index.js";
import { sql } from "kysely";
import { addLeadsToCampaign, getCampaignLeads, ADD_LEADS_BATCH, type SmartleadLeadInput } from "../smartlead.js";
import { getAccountByBoard } from "./accounts.js";
import { normalizeEmail } from "./suppress.js";
import { deriveName } from "./names.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface EligibleContact {
  id: string;
  name: string;
  email: string;
  company: string | null;
  tier: string | null;
  custom_fields: Record<string, unknown>;
  /** The personal first line, present ONLY when a human approved it. An
   *  unreviewed draft is never merged — that's the whole point of approval. */
  openingLine: string | null;
}

/**
 * The gate query. Shared by the dry-run preview and the real export so what you
 * preview is exactly what you send.
 *
 * Outreach is per BOARD and off by default: a board must be explicitly enabled
 * (`crm_boards.outreach_enabled`) before any of its contacts are eligible.
 * Connecting a Smartlead account arms nothing on its own.
 */
export async function selectEligible(
  userId: string,
  opts: { tier: string; boardId: string; limit?: number; requireOpener?: boolean; contactIds?: string[] },
): Promise<EligibleContact[]> {
  // Hard stop: a disabled (or foreign) board yields nothing at all.
  const board = await db
    .selectFrom("crm_boards")
    .select(["id", "outreach_enabled"])
    .where("id", "=", opts.boardId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!board || !board.outreach_enabled) return [];

  let q = db
    .selectFrom("crm_contacts as l")
    .select([
      "l.id", "l.name", "l.email", "l.company", "l.tier", "l.custom_fields",
      "l.opening_line", "l.opening_line_status",
    ])
    .where("l.user_id", "=", userId)
    .where("l.board_id", "=", opts.boardId)
    .where("l.tier", "=", opts.tier)
    .where("l.email", "is not", null)
    // Not already contacted / responded / opted out. Null or 'queued' only.
    .where((eb) => eb.or([eb("l.outreach_status", "is", null), eb("l.outreach_status", "=", "queued")]))
    // Not suppressed by exact email…
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom("suppressions as s")
            .select("s.id")
            .where("s.user_id", "=", userId)
            .where("s.scope", "=", "email")
            .whereRef(eb.fn("lower", ["l.email"]), "=", "s.value"),
        ),
      ),
    )
    // …nor by domain (exact domain OR any subdomain of it).
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom("suppressions as s")
            .select("s.id")
            .where("s.user_id", "=", userId)
            .where("s.scope", "=", "domain")
            // Match the exact domain (…@acme.com) OR any subdomain
            // (…@eu.acme.com). Concatenation done in SQL against s.value.
            .where((inner) =>
              inner.or([
                inner(inner.fn("lower", ["l.email"]), "like", sql<string>`'%@' || ${sql.ref("s.value")}`),
                inner(inner.fn("lower", ["l.email"]), "like", sql<string>`'%.' || ${sql.ref("s.value")}`),
              ]),
            ),
        ),
      ),
    )
    // Not already in a live campaign (active or paused — a paused lead is in a
    // live conversation; a blocked one is suppressed; only truly gone leads are
    // re-eligible, which our statuses already prevent).
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom("outreach_campaign_memberships as cm")
            .select("cm.id")
            .whereRef("cm.contact_id", "=", "l.id")
            .where("cm.state", "in", ["active", "paused", "blocked"]),
        ),
      ),
    )
    // …and no OTHER contact row carrying the same email is in a live campaign.
    // The membership unique key is (contact_id, campaign) — without this, the
    // same human duplicated across two boards gets two parallel sequences.
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom("outreach_campaign_memberships as cm2")
            .innerJoin("crm_contacts as c2", "c2.id", "cm2.contact_id")
            .select("cm2.id")
            .where("cm2.state", "in", ["active", "paused", "blocked"])
            // Correlated to the outer row — raw so the outer alias `l` resolves.
            .where(sql<boolean>`lower(c2.email) = lower(l.email)`),
        ),
      ),
    )
    .orderBy("l.created_at", "asc");

  // Personalised sends only go to people whose line a human approved.
  if (opts.requireOpener) {
    q = q.where("l.opening_line_status", "=", "approved").where("l.opening_line", "is not", null);
  }
  // An explicit selection (the ticked rows on the approval screen). Still
  // subject to every filter above — ticking someone can't bypass suppression.
  if (opts.contactIds) {
    if (!opts.contactIds.length) return [];
    q = q.where("l.id", "in", opts.contactIds);
  }
  if (opts.limit) q = q.limit(opts.limit);

  const rows = await q.execute();
  // Final in-batch dedupe: two contact rows with the same address (neither yet
  // in a campaign, so the SQL predicates can't catch them) must not both be
  // pushed. First row wins — ordering is by created_at, so the original.
  const seen = new Set<string>();
  const out: EligibleContact[] = [];
  for (const r of rows) {
    const email = normalizeEmail(r.email as string);
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({
      id: r.id,
      name: r.name,
      email: r.email as string,
      company: r.company,
      tier: r.tier,
      custom_fields: (r.custom_fields ?? {}) as Record<string, unknown>,
      openingLine: r.opening_line_status === "approved" ? (r.opening_line ?? null) : null,
    });
  }
  return out;
}

function toLeadInput(c: EligibleContact): SmartleadLeadInput {
  const { first, last } = deriveName(c.name);
  // Smartlead custom fields must be strings; carry through only string values
  // (the personalisation hook lives here for Tier B; Tier C has none).
  const custom_fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.custom_fields)) {
    if (typeof v === "string" && v.length > 0) custom_fields[k] = v;
  }
  // The personal first line. Reference it in the Smartlead template as
  // {{opening_line}} — the rest of the body stays one warmed-up template.
  if (c.openingLine) custom_fields.opening_line = c.openingLine;
  return {
    email: normalizeEmail(c.email),
    first_name: first ?? undefined,
    last_name: last ?? undefined,
    company_name: c.company ?? undefined,
    custom_fields: Object.keys(custom_fields).length ? custom_fields : undefined,
  };
}

export interface ExportResult {
  tier: string;
  campaignId: string;
  eligible: number;
  pushed: number;
  idsCaptured: number;
  batches: number;
  /** Held back because no usable first name could be derived — mailing them
   *  would produce a visibly broken greeting. Fix the name, re-export. */
  skippedBadName: number;
}

/**
 * Run the gate and push eligible contacts into the tier's campaign.
 *
 * Provider lead ids are resolved in BULK after the pushes — one paginated
 * `GET /campaigns/{id}/leads` sweep instead of a per-lead `by-email` call.
 * The old shape was N sequential HTTP round-trips (400 leads ≈ 80s per batch),
 * which is what made this untenable inside a request. EMAIL_SENT still
 * backfills any straggler.
 */
export async function exportTier(
  userId: string,
  opts: { tier: string; boardId: string; requireOpener?: boolean; contactIds?: string[]; onProgress?: (note: string) => void },
): Promise<ExportResult> {
  const account = await getAccountByBoard(opts.boardId);
  if (!account) throw new Error("smartlead_not_connected");

  // Outreach must be switched on for THIS board. Enabling is a deliberate,
  // per-board act — never a side effect of connecting an account.
  const board = await db
    .selectFrom("crm_boards")
    .select(["id", "outreach_enabled"])
    .where("id", "=", opts.boardId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!board) throw new Error("board_not_found");
  if (!board.outreach_enabled) throw new Error("outreach_disabled_for_board");

  const campaign = await db
    .selectFrom("outreach_campaigns")
    .selectAll()
    .where("board_id", "=", opts.boardId)
    .where("tier", "=", opts.tier)
    .where("state", "=", "active")
    .executeTakeFirst();
  if (!campaign) throw new Error(`no_active_campaign_for_tier_${opts.tier}`);

  const all = await selectEligible(userId, {
    tier: opts.tier, boardId: opts.boardId,
    requireOpener: opts.requireOpener, contactIds: opts.contactIds,
  });
  // Hold back anyone we can't greet properly rather than sending "Hi Dr.,".
  const eligible = all.filter((c) => deriveName(c.name).first !== null);
  const skippedBadName = all.length - eligible.length;
  if (skippedBadName > 0) {
    opts.onProgress?.(`${skippedBadName} held back — unusable first name`);
    console.warn(`[outreach] export tier ${opts.tier}: ${skippedBadName} contacts held back for unusable names`);
  }
  let pushed = 0;
  let idsCaptured = 0;
  let batches = 0;

  const totalBatches = Math.ceil(eligible.length / ADD_LEADS_BATCH);
  for (let i = 0; i < eligible.length; i += ADD_LEADS_BATCH) {
    const slice = eligible.slice(i, i + ADD_LEADS_BATCH);
    await addLeadsToCampaign(campaign.provider_campaign_id, slice.map(toLeadInput), account.apiKey);
    batches++;

    for (const c of slice) {
      await db
        .insertInto("outreach_campaign_memberships")
        .values({
          user_id: userId,
          contact_id: c.id,
          campaign_id: campaign.id,
          provider_campaign_id: campaign.provider_campaign_id,
          provider_lead_id: null, // resolved in the bulk sweep below
          state: "active",
        })
        .onConflict((oc) => oc.columns(["contact_id", "provider_campaign_id"]).doNothing())
        .execute();
      await db
        .updateTable("crm_contacts")
        .set({ outreach_status: "contacted", outreach_status_at: new Date() })
        .where("id", "=", c.id)
        .execute();
      pushed++;
    }
    opts.onProgress?.(`batch ${batches}/${totalBatches} — ${pushed} pushed`);
    if (i + ADD_LEADS_BATCH < eligible.length) await sleep(500); // gentle on the rate limit
  }

  // Bulk-resolve provider_lead_id: one paginated sweep of the campaign, matched
  // by email, instead of a lookup per lead.
  if (pushed > 0) {
    opts.onProgress?.("resolving lead ids");
    try {
      const slLeads = await getCampaignLeads(campaign.provider_campaign_id, account.apiKey);
      const byEmail = new Map<string, string>();
      for (const l of slLeads) {
        if (l.email && l.leadId) byEmail.set(l.email.toLowerCase(), l.leadId);
      }
      for (const c of eligible) {
        const leadId = byEmail.get(normalizeEmail(c.email));
        if (!leadId) continue;
        const r = await db
          .updateTable("outreach_campaign_memberships")
          .set({ provider_lead_id: leadId, updated_at: new Date() as never })
          .where("contact_id", "=", c.id)
          .where("provider_campaign_id", "=", campaign.provider_campaign_id)
          .where("provider_lead_id", "is", null)
          .executeTakeFirst();
        if (Number(r.numUpdatedRows ?? 0) > 0) idsCaptured++;
      }
    } catch (err) {
      // Non-fatal: EMAIL_SENT webhooks backfill the ids, and pause falls back
      // to a by-email lookup. Don't fail a successful push over this.
      console.error("[outreach] bulk lead-id resolution failed:", (err as Error).message);
    }
  }

  return { tier: opts.tier, campaignId: campaign.provider_campaign_id, eligible: eligible.length, pushed, idsCaptured, batches, skippedBadName };
}

// Re-exported so callers can keep importing the send filter and its companions
// from one place.
export { deriveName } from "./names.js";
export { selectExcluded, type ExcludedContact } from "./excluded.js";
