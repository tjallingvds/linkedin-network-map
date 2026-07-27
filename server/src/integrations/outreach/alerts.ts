/**
 * Deliverability alerts, delivered in-app (spec §8 routed these to Slack; we
 * keep the alarm but surface it in the product rather than depending on a
 * third-party webhook).
 *
 * Writing an alert must never throw into a webhook ack path or a reconcile
 * sweep — failing to record a notification is not a reason to fail a send-stop.
 *
 * Repeat suppression: a partial unique index allows only ONE unread alert per
 * (user, kind, campaign), so a nightly job that keeps finding the same bad
 * campaign updates that row instead of piling up a new one every night.
 */
import { db } from "../../db/index.js";

export type AlertKind = "bounce_rate" | "bounce_threshold" | "live_leak" | "reply_recovered";

export interface OutreachAlert {
  id: string;
  kind: string;
  severity: string;
  message: string;
  provider_campaign_id: string | null;
  created_at: Date;
}

/**
 * Raise an in-app alert. Idempotent per (user, kind, campaign) while unread:
 * a repeat refreshes the message and timestamp rather than adding a duplicate.
 */
export async function alertUser(
  userId: string,
  message: string,
  opts: { kind?: AlertKind; severity?: "warning" | "critical"; campaignId?: string | null } = {},
): Promise<void> {
  const kind = opts.kind ?? "bounce_rate";
  const campaignId = opts.campaignId ?? null;
  try {
    const existing = await db
      .selectFrom("outreach_alerts")
      .select("id")
      .where("user_id", "=", userId)
      .where("kind", "=", kind)
      .where("read_at", "is", null)
      .where((eb) => (campaignId === null
        ? eb("provider_campaign_id", "is", null)
        : eb("provider_campaign_id", "=", campaignId)))
      .executeTakeFirst();

    if (existing) {
      await db.updateTable("outreach_alerts")
        .set({ message, severity: opts.severity ?? "warning", created_at: new Date() as never })
        .where("id", "=", existing.id).execute();
      return;
    }
    await db.insertInto("outreach_alerts").values({
      user_id: userId, kind, severity: opts.severity ?? "warning",
      message, provider_campaign_id: campaignId,
    }).execute();
  } catch (err) {
    // Never let a notification failure break the caller.
    console.error("[alerts] could not record alert:", (err as Error).message);
    console.warn(`[alerts] ${message}`);
  }
}

/**
 * Unread alerts first, newest first. `boardId` narrows to alerts raised for
 * that board's campaigns (plus account-wide alerts that carry no campaign).
 */
export async function listAlerts(userId: string, includeRead = false, boardId?: string) {
  let q = db
    .selectFrom("outreach_alerts")
    .select(["id", "kind", "severity", "message", "provider_campaign_id", "read_at", "created_at"])
    .where("user_id", "=", userId);
  if (!includeRead) q = q.where("read_at", "is", null);
  if (boardId) {
    q = q.where((eb) =>
      eb.or([
        eb("provider_campaign_id", "is", null),
        eb("provider_campaign_id", "in", (qb) =>
          qb.selectFrom("outreach_campaigns").select("provider_campaign_id").where("board_id", "=", boardId)),
      ]),
    );
  }
  return q.orderBy("created_at", "desc").limit(50).execute();
}

export async function unreadAlertCount(userId: string): Promise<number> {
  const row = await db
    .selectFrom("outreach_alerts")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("user_id", "=", userId)
    .where("read_at", "is", null)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** Dismiss one alert, or all of them when no id is given. */
export async function markAlertsRead(userId: string, id?: string): Promise<void> {
  let q = db.updateTable("outreach_alerts")
    .set({ read_at: new Date() as never })
    .where("user_id", "=", userId)
    .where("read_at", "is", null);
  if (id) q = q.where("id", "=", id);
  await q.execute();
}
