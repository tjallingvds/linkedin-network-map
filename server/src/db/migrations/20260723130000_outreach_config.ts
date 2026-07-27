/**
 * Outreach configuration + in-app alerting.
 *
 *  1. Per-board stage mapping. The card-drag → pause hook was matching stage
 *     labels by keyword, so boards using "Nurture" / "Follow-up" / "Pipeline"
 *     silently never triggered a pause — the worst kind of failure, because
 *     the operator believes it works. Boards now declare which of their own
 *     stages mean engaged (stop sending) or cold (resume).
 *
 *  2. Deliverability alerts as in-app notifications. Spec §8 routed the
 *     bounce-threshold alarm to Slack; we keep the alarm but deliver it in the
 *     product instead of depending on a third-party webhook. Rows are written
 *     by the nightly bounce check and by Smartlead's own threshold event, and
 *     surface in the Outreach panel until dismissed.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("crm_boards")
    /** Outreach is OFF for every board until explicitly switched on. Connecting
     *  a Smartlead account does not arm anything: with this false the export
     *  gate returns nothing for the board and the card-drag hook is inert. */
    .addColumn("outreach_enabled", "boolean", (c) => c.notNull().defaultTo(false))
    /** { "noSend": ["replied","Replied"] } — the stage ids and labels that
     *  mean "stop emailing". Null = no stage stops sending. */
    .addColumn("outreach_stage_map", "jsonb")
    /** The board's own instructions for writing opening lines. Null = use the
     *  built-in prompt. Editable so the voice matches the campaign. */
    .addColumn("opening_prompt", "text")
    .execute();

  await db.schema
    .alterTable("smartlead_accounts")
    /** Bounce rate (percent) at which a campaign raises an alert. 2% is where
     *  inbox providers start treating a sender as careless — past it you are
     *  damaging the domain, not just wasting sends, so warn early. */
    .addColumn("bounce_threshold_pct", "integer", (c) => c.notNull().defaultTo(2))
    .execute();

  await db.schema
    .createTable("outreach_alerts")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    /** 'bounce_rate' | 'bounce_threshold' | 'live_leak' | 'reply_recovered'. */
    .addColumn("kind", "text", (c) => c.notNull())
    /** 'warning' | 'critical' — drives how loudly the UI shows it. */
    .addColumn("severity", "text", (c) => c.notNull().defaultTo("warning"))
    .addColumn("message", "text", (c) => c.notNull())
    .addColumn("provider_campaign_id", "text")
    /** Null until the operator dismisses it. */
    .addColumn("read_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // Unread-first listing per user.
  await db.schema
    .createIndex("outreach_alerts_user_idx")
    .on("outreach_alerts")
    .columns(["user_id", "read_at", "created_at"])
    .execute();

  // Dedupe guard: one unread alert per (user, kind, campaign) so a nightly
  // job that keeps finding the same bad campaign doesn't pile up 30 rows.
  await db.schema
    .createIndex("outreach_alerts_unread_uniq")
    .on("outreach_alerts")
    .columns(["user_id", "kind", "provider_campaign_id"])
    .where(sql.ref("read_at"), "is", null)
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("outreach_alerts").ifExists().execute();
  await db.schema.alterTable("crm_boards").dropColumn("outreach_enabled").execute();
  await db.schema.alterTable("crm_boards").dropColumn("outreach_stage_map").execute();
  await db.schema.alterTable("crm_boards").dropColumn("opening_prompt").execute();
  await db.schema.alterTable("smartlead_accounts").dropColumn("bounce_threshold_pct").execute();
}
