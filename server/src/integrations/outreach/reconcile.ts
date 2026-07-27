/**
 * Reconciliation (spec §6). Webhooks are delivered, not guaranteed. Once a day,
 * per connected BOARD, diff Smartlead's per-lead state against our memberships:
 *
 *   - Smartlead says replied but we never marked it → recover the reply.
 *     State-diffing alone cannot see this: if we missed the webhook, both sides
 *     read "active" and agree.
 *   - CRM says paused, Smartlead says active → re-issue the pause + alert.
 *     That direction is a live leak: we're sending at someone we meant to stop.
 *   - Smartlead says blocked/completed, CRM says active → correct the CRM.
 *
 * A rising `releaks` count means the webhook path is degrading. This is a daily
 * drift check, not an event source — do not poll it in realtime.
 */
import { db } from "../../db/index.js";
import { getAccountByBoard, listAccounts, type OutreachAccount } from "./accounts.js";
import { getCampaignLeads, pauseLead, mapLeadStatusToState } from "../smartlead.js";
import { pauseContactCampaigns } from "./suppress.js";
import { isAutoReply } from "./events.js";
import { bounceBreaches, BOUNCE_LIMIT_PCT, BOUNCE_MIN_SENDS } from "./metrics.js";
import { alertUser } from "./alerts.js";
import { applyStageRule } from "./stage-rules.js";

export interface ReconcileCounts {
  campaigns: number;
  checked: number;
  releaks: number;
  corrected: number;
  repliesRecovered: number;
  /** People Smartlead had already emailed that we hadn't noticed — the state
   *  the send webhook normally reports. */
  sendsNoticed: number;
  /** Cards those sends moved, and how many found no rule to move them. */
  cardsMoved: number;
  noRule: number;
  bounceAlerts?: number;
  /** Campaigns whose leads couldn't be read from Smartlead. Reported, because
   *  a run that checked nothing must never be described as "all matches". */
  unreadable: number;
}

const zero = (): ReconcileCounts =>
  ({ campaigns: 0, checked: 0, releaks: 0, corrected: 0, repliesRecovered: 0, sendsNoticed: 0, cardsMoved: 0, noRule: 0, unreadable: 0 });

/** Reconcile a single connected board. */
export async function reconcileAccount(account: OutreachAccount): Promise<ReconcileCounts> {
  const counts = zero();
  const { userId, boardId, apiKey } = account;

  const campaigns = await db
    .selectFrom("outreach_campaigns")
    .selectAll()
    .where("board_id", "=", boardId)
    .where("state", "=", "active")
    .execute();

  for (const campaign of campaigns) {
    counts.campaigns++;
    let slLeads;
    try {
      slLeads = await getCampaignLeads(campaign.provider_campaign_id, apiKey);
    } catch (err) {
      console.error(`[reconcile] campaign ${campaign.provider_campaign_id} fetch failed:`, (err as Error).message);
      counts.unreadable++;
      continue;
    }
    const byLeadId = new Map(slLeads.filter((l) => l.leadId).map((l) => [l.leadId as string, l]));
    const byEmail = new Map(slLeads.filter((l) => l.email).map((l) => [l.email!.toLowerCase(), l]));

    const memberships = await db
      .selectFrom("outreach_campaign_memberships as cm")
      .innerJoin("crm_contacts as c", "c.id", "cm.contact_id")
      .select([
        "cm.id as id", "cm.state as state", "cm.provider_lead_id as provider_lead_id",
        "c.email as email", "c.id as contact_id", "c.outreach_status as outreach_status",
      ])
      .where("cm.campaign_id", "=", campaign.id)
      .execute();

    for (const m of memberships) {
      counts.checked++;
      const sl =
        (m.provider_lead_id && byLeadId.get(m.provider_lead_id)) ||
        (m.email && byEmail.get(m.email.toLowerCase())) ||
        null;
      if (!sl) continue;

      // Missed-reply recovery — the case a state diff can never surface.
      if (
        sl.replied &&
        !isAutoReply(sl.category ?? undefined) &&
        m.outreach_status !== "responded" &&
        m.outreach_status !== "do_not_contact"
      ) {
        await db.updateTable("crm_contacts")
          .set({ outreach_status: "responded", outreach_status_at: new Date() })
          .where("id", "=", m.contact_id).execute();
        await pauseContactCampaigns(userId, m.contact_id);
        counts.repliesRecovered++;
        console.warn(`[reconcile] recovered missed reply for ${m.email ?? m.contact_id}`);
        continue;
      }

      // Smartlead has emailed them and we never heard about it. Without this
      // the card sits in its first column for ever and nobody is marked
      // contacted — exactly what a silent webhook looks like from the board.
      if (sl.sent) {
        if (m.outreach_status === null || m.outreach_status === "queued") {
          await db.updateTable("crm_contacts")
            .set({ outreach_status: "contacted", outreach_status_at: new Date() })
            .where("id", "=", m.contact_id).execute();
          counts.sendsNoticed++;
        }
        // Tried on every pass, not just the one that flips the status. A card
        // that should have moved and didn't — because no rule existed yet, or
        // the run that marked them contacted predated the rule — would
        // otherwise stay put for ever, since the status only changes once.
        // ruleFor already no-ops when the card is where the rule points, so
        // repeating this is free.
        const move = await applyStageRule(userId, m.contact_id, "sent");
        if (move.moved !== null) counts.cardsMoved++;
        else if (move.why === "no-rules" || move.why === "no-match") counts.noRule++;
      }

      const slState = mapLeadStatusToState(sl.status);
      if (!slState) continue;

      if (m.state === "paused" && slState === "active" && (m.provider_lead_id || sl.leadId)) {
        const leadId = (m.provider_lead_id ?? sl.leadId) as string;
        try {
          await pauseLead(campaign.provider_campaign_id, leadId, apiKey);
          counts.releaks++;
          console.warn(`[reconcile] ALERT live leak re-paused: campaign ${campaign.provider_campaign_id} lead ${leadId}`);
        } catch (err) {
          console.error(`[reconcile] failed to re-pause lead ${leadId}:`, (err as Error).message);
        }
        continue;
      }

      if ((slState === "blocked" || slState === "completed") && m.state === "active") {
        await db.updateTable("outreach_campaign_memberships")
          .set({ state: slState, updated_at: new Date() as never }).where("id", "=", m.id).execute();
        counts.corrected++;
      }
    }
  }

  // Our own bounce-rate guardrail, independent of Smartlead's threshold event.
  try {
    const threshold = BOUNCE_LIMIT_PCT;
    const breaches = await bounceBreaches(userId, threshold, BOUNCE_MIN_SENDS, boardId);
    for (const b of breaches) {
      await alertUser(
        userId,
        `Bounce rate ${b.bounceRate}% on Tier ${b.tier ?? "?"} (${b.bounced}/${b.sent}) — over your ` +
        `${threshold}% limit. Stop sending and fix list quality before it costs you domain reputation.`,
        { kind: "bounce_rate", severity: b.bounceRate >= threshold * 2 ? "critical" : "warning", campaignId: b.campaignId },
      );
    }
    if (breaches.length) counts.bounceAlerts = breaches.length;
  } catch (err) {
    console.error("[reconcile] bounce check failed:", (err as Error).message);
  }

  console.log(`[reconcile] board ${boardId}: ${JSON.stringify(counts)}`);
  return counts;
}

/** Reconcile one board on demand (the "Reconcile now" button). */
export async function reconcileBoard(boardId: string): Promise<ReconcileCounts> {
  const account = await getAccountByBoard(boardId);
  if (!account) return zero();
  return reconcileAccount(account);
}

/**
 * Boards Smartlead has never called back.
 *
 * With no webhook arriving, this sweep is the only thing that notices a reply
 * and stops the follow-ups — so those boards are swept hourly instead of
 * daily, and drop back to daily the moment a real event shows up.
 */
export async function reconcileWebhookless(): Promise<number> {
  let n = 0;
  for (const account of await listAccounts()) {
    const seen = await db
      .selectFrom("outreach_events").select("id")
      .where("user_id", "=", account.userId).limit(1).executeTakeFirst();
    if (seen) continue;
    try {
      await reconcileAccount(account);
      n++;
    } catch (err) {
      console.error(`[reconcile] webhookless board ${account.boardId} failed:`, (err as Error).message);
    }
  }
  return n;
}

/** Reconcile every connected board. Called by the daily scheduler. */
export async function reconcileAll(): Promise<void> {
  for (const account of await listAccounts()) {
    try {
      await reconcileAccount(account);
    } catch (err) {
      console.error(`[reconcile] board ${account.boardId} failed:`, (err as Error).message);
    }
  }
}
