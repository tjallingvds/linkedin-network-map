/**
 * Outreach orchestration — Smartlead email sending driven from the CRM.
 *
 * Design principle (see spec): the CRM is the system of record for who may be
 * contacted. Smartlead is a dumb sender. Every suppression decision is made
 * here and enforced at export time. If this DB is down, nothing sends — that
 * is the correct failure mode.
 *
 * Per-user (BYO Smartlead): each user connects their own Smartlead account.
 * The API key is stored encrypted (not header-only like Apollo) because the
 * nightly reconciler and the webhook handler run with no user request in the
 * loop and still need to call Smartlead.
 *
 * Five additions, all keyed off the existing `crm_contacts` row (the person
 * record). No existing table is renamed.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── Per-BOARD Smartlead credentials + inbound webhook identity ───────────
  // Each board connects its own Smartlead account, so different boards can
  // send from entirely separate sending infrastructure (different domains,
  // mailboxes, even different clients) without ever sharing a key. The webhook
  // token is per board too, which is what lets an inbound event be attributed
  // to exactly one board before its body is even parsed.
  await db.schema
    .createTable("smartlead_accounts")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("board_id", "uuid", (c) => c.notNull().unique().references("crm_boards.id").onDelete("cascade"))
    /** AES-256-GCM ciphertext (base64: iv|tag|data). Never stored in plaintext. */
    .addColumn("api_key_encrypted", "text", (c) => c.notNull())
    /** Opaque token that appears IN the webhook URL (/hooks/smartlead/:token).
     *  Lets us identify the account before we can read the body. */
    .addColumn("webhook_token", "text", (c) => c.notNull().unique())
    /** HMAC-SHA256 secret used to verify X-Smartlead-Signature over the raw body. */
    .addColumn("webhook_secret", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // ── Campaign registry: maps a Smartlead campaign to a BOARD + content tier ─
  // Outreach is configured per CRM board, not per account: a board opts in
  // (crm_boards.outreach_enabled, default false) and wires its own tier →
  // campaign mapping. The export gate routes a contact's tier into that board's
  // campaign; the webhook handler maps an inbound campaign_id back to the row,
  // and from there to the owning board and user.
  await db.schema
    .createTable("outreach_campaigns")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    /** The board this campaign serves. Outreach never spans boards. */
    .addColumn("board_id", "uuid", (c) => c.notNull().references("crm_boards.id").onDelete("cascade"))
    /** Smartlead's campaign id (their integer, stored as text). */
    .addColumn("provider_campaign_id", "text", (c) => c.notNull())
    /** Content tier this campaign carries: 'A' | 'B' | 'C'. */
    .addColumn("tier", "text", (c) => c.notNull())
    .addColumn("name", "text")
    /** 'active' | 'paused' | 'completed'. */
    .addColumn("state", "text", (c) => c.notNull().defaultTo("active"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("outreach_campaigns_board_idx")
    .on("outreach_campaigns")
    .column("board_id")
    .execute();
  // One campaign per tier per board.
  await db.schema
    .createIndex("outreach_campaigns_board_tier_uniq")
    .on("outreach_campaigns")
    .columns(["board_id", "tier"])
    .unique()
    .execute();
  // A given Smartlead campaign belongs to exactly one board, otherwise an
  // inbound webhook could not be attributed to a single board.
  await db.schema
    .createIndex("outreach_campaigns_provider_uniq")
    .on("outreach_campaigns")
    .columns(["user_id", "provider_campaign_id"])
    .unique()
    .execute();

  // ── Provider-ID storage: one row per contact per campaign ────────────────
  // provider_lead_id is captured at import time (from the add-leads response /
  // by-email lookup) and backfilled from the EMAIL_SENT webhook. Without it,
  // every suppression call would need a lookup-by-email at the worst moment.
  await db.schema
    .createTable("outreach_campaign_memberships")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("contact_id", "uuid", (c) => c.notNull().references("crm_contacts.id").onDelete("cascade"))
    .addColumn("campaign_id", "uuid", (c) => c.notNull().references("outreach_campaigns.id").onDelete("cascade"))
    /** Denormalised so a suppression call needs no join. */
    .addColumn("provider_campaign_id", "text", (c) => c.notNull())
    /** Smartlead lead id. Null until captured at import or first EMAIL_SENT. */
    .addColumn("provider_lead_id", "text")
    /** 'active' | 'paused' | 'completed' | 'blocked'. */
    .addColumn("state", "text", (c) => c.notNull().defaultTo("active"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("ocm_contact_idx")
    .on("outreach_campaign_memberships")
    .column("contact_id")
    .execute();
  // One membership per (contact, campaign). Backstop against double-add.
  await db.schema
    .createIndex("ocm_contact_campaign_uniq")
    .on("outreach_campaign_memberships")
    .columns(["contact_id", "provider_campaign_id"])
    .unique()
    .execute();
  // Fast lookup from an inbound webhook: (campaign, lead) -> membership.
  await db.schema
    .createIndex("ocm_provider_lead_idx")
    .on("outreach_campaign_memberships")
    .columns(["provider_campaign_id", "provider_lead_id"])
    .execute();

  // ── Suppression list: keyed by email and, separately, by domain ──────────
  await db.schema
    .createTable("suppressions")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    /** 'email' | 'domain'. */
    .addColumn("scope", "text", (c) => c.notNull())
    /** Lowercased email address or bare domain. */
    .addColumn("value", "text", (c) => c.notNull())
    /** 'opt_out' | 'compliance' | 'bounce_hard' | 'manual'. Determines which
     *  Smartlead lever (if any) was pulled. */
    .addColumn("reason", "text", (c) => c.notNull())
    /** When the matching Smartlead-side suppression (global unsubscribe /
     *  domain block) was confirmed. Null = CRM-only so far. */
    .addColumn("synced_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("suppressions_user_value_uniq")
    .on("suppressions")
    .columns(["user_id", "scope", "value"])
    .unique()
    .execute();

  // ── Append-only event log — idempotency for the webhook handler ──────────
  // The unique constraint on request_id is the dedupe mechanism. Handlers are
  // ALSO written to be idempotent, because X-Request-Id stability across
  // retries is not guaranteed by Smartlead's docs (see spec open items).
  await db.schema
    .createTable("outreach_events")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.references("users.id").onDelete("cascade"))
    /** Smartlead's X-Request-Id. Nullable: a webhook without one is still
     *  acked (we just can't dedupe it). Postgres allows many NULLs under a
     *  unique index, so this stays unique for the non-null case. */
    .addColumn("request_id", "text")
    .addColumn("event_type", "text", (c) => c.notNull())
    .addColumn("provider_campaign_id", "text")
    .addColumn("provider_lead_id", "text")
    .addColumn("to_email", "text")
    .addColumn("contact_id", "uuid")
    .addColumn("payload", "jsonb")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("outreach_events_request_uniq")
    .on("outreach_events")
    .column("request_id")
    .unique()
    .execute();

  // ── Route + suppress fields on the person record ─────────────────────────
  // Kept separate from the freeform kanban `stage` (which is per-board and
  // user-defined) so outreach state has a controlled vocabulary of its own.
  await db.schema
    .alterTable("crm_contacts")
    .addColumn("tier", "text") // 'A' | 'B' | 'C' | null (null = not in outreach)
    /** The personal first line, drafted from this contact's own CRM context and
     *  merged into the Smartlead template as {{opening_line}}. Never invented:
     *  when the context is too thin the drafter returns nothing and the person
     *  is held back rather than sent a generic-but-personal-looking line. */
    .addColumn("opening_line", "text")
    /** Which facts the line was built from — shown next to it for review. */
    .addColumn("opening_line_source", "text")
    /** null | 'draft' | 'approved' | 'skipped' (not enough context). */
    .addColumn("opening_line_status", "text")
    .addColumn("opening_line_at", "timestamptz")
    .addColumn("sector", "text")
    /** Controlled outreach lifecycle, distinct from `stage`:
     *  null | 'queued' | 'contacted' | 'responded' | 'do_not_contact'. */
    .addColumn("outreach_status", "text")
    .addColumn("outreach_status_at", "timestamptz")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("crm_contacts").dropColumn("tier").execute();
  await db.schema.alterTable("crm_contacts").dropColumn("sector").execute();
  await db.schema.alterTable("crm_contacts").dropColumn("outreach_status").execute();
  await db.schema.alterTable("crm_contacts").dropColumn("outreach_status_at").execute();
  await db.schema.dropTable("outreach_events").ifExists().execute();
  await db.schema.dropTable("suppressions").ifExists().execute();
  await db.schema.dropTable("outreach_campaign_memberships").ifExists().execute();
  await db.schema.dropTable("outreach_campaigns").ifExists().execute();
  await db.schema.dropTable("smartlead_accounts").ifExists().execute();
}
