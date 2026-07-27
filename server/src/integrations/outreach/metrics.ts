/**
 * The bounce rate that means "stop and clean the list".
 *
 * Fixed, not configurable: 2% is where mailbox providers start treating a
 * sender as careless, and it is not a number anyone benefits from tuning
 * upward — raising it only hides the damage. `smartlead_accounts.
 * bounce_threshold_pct` is left in the schema but is no longer read.
 */
export const BOUNCE_LIMIT_PCT = 2;

/** Below this many sends, a bounce rate is noise rather than a signal. */
export const BOUNCE_MIN_SENDS = 20;

/**
 * Outreach funnel metrics, computed from the append-only event log.
 *
 * Deliberately NO open rate: corporate security gateways (Mimecast,
 * Proofpoint) pre-fetch links and render images, so opens fire on the gateway
 * rather than the human. An open-rate number for this ICP is a lie you would
 * then optimise toward. The north star is positive reply rate.
 *
 * `sent` counts DISTINCT contacts, not events — a 4-step sequence fires
 * EMAIL_SENT four times for one person, and a per-person denominator is what
 * makes reply rate meaningful.
 */
import { db } from "../../db/index.js";
import { isAutoReply } from "./events.js";

export interface FunnelRow {
  tier: string | null;
  campaignId: string | null;
  campaignName: string | null;
  sent: number;
  bounced: number;
  delivered: number;
  replied: number;
  autoReplied: number;
  unsubscribed: number;
  bounceRate: number; // %
  replyRate: number; // % of delivered
  unsubRate: number; // % of delivered
}

interface RawEvent {
  provider_campaign_id: string | null;
  event_type: string;
  to_email: string | null;
  payload: unknown;
}

/**
 * Build the funnel for a user, all time. Reads raw events and folds them in
 * JS: the auto-reply classification lives in code (shared with the webhook
 * handler) rather than being duplicated as SQL.
 */
export async function funnel(userId: string, boardId?: string): Promise<FunnelRow[]> {
  // Everything since the campaign started. A rolling window would quietly drop
  // early sends and make the bounce rate look better than it is.
  const events = (await db
    .selectFrom("outreach_events")
    .select(["provider_campaign_id", "event_type", "to_email", "payload"])
    .where("user_id", "=", userId)
    .execute()) as RawEvent[];

  let cq = db
    .selectFrom("outreach_campaigns")
    .select(["provider_campaign_id", "tier", "name"])
    .where("user_id", "=", userId);
  if (boardId) cq = cq.where("board_id", "=", boardId);
  const campaigns = await cq.execute();
  const meta = new Map(campaigns.map((c) => [c.provider_campaign_id, c]));

  // campaign -> metric -> set of distinct contact emails
  const buckets = new Map<string, Record<string, Set<string>>>();
  const bucket = (cid: string) => {
    let b = buckets.get(cid);
    if (!b) {
      b = { sent: new Set(), bounced: new Set(), replied: new Set(), auto: new Set(), unsub: new Set() };
      buckets.set(cid, b);
    }
    return b;
  };

  for (const e of events) {
    const cid = e.provider_campaign_id ?? "unknown";
    const who = (e.to_email ?? "").toLowerCase();
    if (!who) continue;
    // Board-scoped view: ignore events belonging to another board's campaigns.
    if (boardId && !meta.has(cid)) continue;
    const b = bucket(cid);
    const p = (typeof e.payload === "string" ? safeParse(e.payload) : e.payload) as Record<string, unknown> | null;
    const category = (p?.lead_category ?? p?.category) as string | undefined;

    switch (e.event_type) {
      case "EMAIL_SENT":
      case "FIRST_EMAIL_SENT":
        b.sent.add(who); break;
      case "EMAIL_BOUNCE":
        b.bounced.add(who); break;
      case "EMAIL_REPLY":
      case "LEAD_CATEGORY_UPDATED":
        (isAutoReply(category) ? b.auto : b.replied).add(who); break;
      case "LEAD_UNSUBSCRIBED":
        b.unsub.add(who); break;
      default: break;
    }
  }

  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

  return [...buckets.entries()]
    .map(([cid, b]) => {
      const sent = b.sent.size;
      const bounced = b.bounced.size;
      const delivered = Math.max(0, sent - bounced);
      const replied = b.replied.size;
      const unsubscribed = b.unsub.size;
      const m = meta.get(cid);
      return {
        tier: m?.tier ?? null,
        campaignId: cid === "unknown" ? null : cid,
        campaignName: m?.name ?? null,
        sent, bounced, delivered, replied,
        autoReplied: b.auto.size,
        unsubscribed,
        bounceRate: pct(bounced, sent),
        replyRate: pct(replied, delivered),
        unsubRate: pct(unsubscribed, delivered),
      };
    })
    .sort((a, b) => (a.tier ?? "z").localeCompare(b.tier ?? "z"));
}

function safeParse(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
}

/**
 * Bounce-rate guardrail. Returns campaigns over the account's threshold, with
 * a minimum volume so a 1-of-2 bounce on a brand-new campaign doesn't alarm.
 */
export async function bounceBreaches(
  userId: string,
  thresholdPct: number,
  minSent = 20,
  boardId?: string,
): Promise<FunnelRow[]> {
  const rows = await funnel(userId, boardId);
  return rows.filter((r) => r.sent >= minSent && r.bounceRate >= thresholdPct);
}
