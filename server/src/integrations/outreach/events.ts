/**
 * Webhook event processing (spec §3). Maps Smartlead events onto CRM state.
 *
 * IMPORTANT — event names verified against the live Smartlead reference:
 *   EMAIL_SENT          (also FIRST_EMAIL_SENT)
 *   EMAIL_REPLY         (NOT "EMAIL_REPLIED")
 *   EMAIL_BOUNCE        (NOT "EMAIL_BOUNCED")
 *   LEAD_UNSUBSCRIBED   (NOT "EMAIL_UNSUBSCRIBED")
 *   LEAD_CATEGORY_UPDATED   (reply categorisation — used to skip OOO/auto)
 *
 * Every handler is idempotent: an event may arrive more than once. That does
 * NOT depend on X-Request-Id being stable across retries (the docs never said
 * it is) — the dedupe index is a fast path, and replaying the same event under
 * a *different* request id is proven not to re-pause, re-suppress, or churn
 * status. See test/outreach.e2e.ts, "Idempotency without X-Request-Id".
 */
import { db } from "../../db/index.js";
import type { OutreachAccount } from "./accounts.js";
import { pauseContactCampaigns, suppressEmail, normalizeEmail } from "./suppress.js";
import { alertUser } from "./alerts.js";

/** Loose shape — Smartlead payload fields vary; read defensively. */
export interface SmartleadWebhookPayload {
  event_type?: string;
  event?: string;
  campaign_id?: number | string;
  lead_id?: number | string;
  to_email?: string;
  email?: string;
  lead_email?: string;
  bounce_type?: string;
  /** Reply categorisation, when present (LEAD_CATEGORY_UPDATED / EMAIL_REPLY). */
  lead_category?: string;
  category?: string;
  [k: string]: unknown;
}

export function eventTypeOf(p: SmartleadWebhookPayload): string {
  return String(p.event_type ?? p.event ?? "").toUpperCase();
}
function emailOf(p: SmartleadWebhookPayload): string | null {
  const e = p.to_email ?? p.email ?? p.lead_email;
  return e ? normalizeEmail(String(e)) : null;
}
function campaignOf(p: SmartleadWebhookPayload): string | null {
  return p.campaign_id === undefined || p.campaign_id === null ? null : String(p.campaign_id);
}
function leadIdOf(p: SmartleadWebhookPayload): string | null {
  return p.lead_id === undefined || p.lead_id === null ? null : String(p.lead_id);
}

/** A reply category that means "never email this person again". Smartlead
 *  categorises replies, so an explicit opt-out arriving as a REPLY (rather than
 *  an unsubscribe click) is caught here and suppressed automatically. */
export function isDoNotContact(category: string | undefined): boolean {
  if (!category) return false;
  const c = category.toLowerCase();
  return c.includes("do not contact") || c.includes("do-not-contact")
    || c.includes("unsubscrib") || c.includes("opt out") || c.includes("opt-out")
    || c.includes("remove me");
}

/** A reply we should NOT treat as a live human conversation: out-of-office and
 *  automated responders. Everything else (incl. "not interested", "wrong
 *  person") is a real human touch and should pause the sequence. */
export function isAutoReply(category: string | undefined): boolean {
  if (!category) return false;
  const c = category.toLowerCase();
  return c.includes("out of office") || c.includes("out-of-office") || c.includes("ooo")
    || c.includes("auto") || c.includes("bounce");
}

async function findContact(
  userId: string,
  boardId: string,
  campaignId: string | null,
  leadId: string | null,
  email: string | null,
): Promise<{ contactId: string; membershipId: string | null } | null> {
  // Best: match membership by (campaign, lead id).
  if (campaignId && leadId) {
    const m = await db
      .selectFrom("outreach_campaign_memberships")
      .select(["id", "contact_id"])
      .where("provider_campaign_id", "=", campaignId)
      .where("provider_lead_id", "=", leadId)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (m) return { contactId: m.contact_id, membershipId: m.id };
  }
  // Fallback: match by email WITHIN the board this webhook belongs to.
  if (email) {
    const c = await db
      .selectFrom("crm_contacts")
      .select(["id"])
      .where("user_id", "=", userId)
      .where("board_id", "=", boardId)
      .where((eb) => eb(eb.fn("lower", ["email"]), "=", email))
      .executeTakeFirst();
    if (c) return { contactId: c.id, membershipId: null };
  }
  return null;
}

/**
 * Process one already-verified, already-deduped webhook payload.
 * Returns a short label for logging.
 */
export async function processEvent(account: OutreachAccount, p: SmartleadWebhookPayload): Promise<string> {
  const type = eventTypeOf(p);
  const email = emailOf(p);
  const campaignId = campaignOf(p);
  const leadId = leadIdOf(p);
  const category = (p.lead_category ?? p.category) as string | undefined;
  const match = await findContact(account.userId, account.boardId, campaignId, leadId, email);

  switch (type) {
    case "EMAIL_SENT":
    case "FIRST_EMAIL_SENT": {
      // The reliable-enough moment to backfill provider_lead_id if the
      // import-time by-email lookup missed it.
      if (campaignId && leadId) {
        await db
          .updateTable("outreach_campaign_memberships")
          .set({ provider_lead_id: leadId, updated_at: new Date() as any })
          .where("provider_campaign_id", "=", campaignId)
          .where("user_id", "=", account.userId)
          .where("provider_lead_id", "is", null)
          .where("contact_id", "=", match?.contactId ?? "00000000-0000-0000-0000-000000000000")
          .execute();
      }
      if (match) {
        await db
          .updateTable("crm_contacts")
          .set({ outreach_status: "contacted", outreach_status_at: new Date() })
          .where("id", "=", match.contactId)
          .where((eb) => eb.or([eb("outreach_status", "is", null), eb("outreach_status", "=", "queued")]))
          .execute();
      }
      return "email_sent";
    }

    case "EMAIL_REPLY":
    case "LEAD_CATEGORY_UPDATED": {
      if (!match) return "reply_no_contact";
      if (isAutoReply(category)) return `reply_auto(${category})`; // do NOT pause on OOO/auto
      // "Stop emailing me" arriving as a reply is a real opt-out — suppress it
      // without waiting for an unsubscribe click that may never come.
      if (isDoNotContact(category) && email) {
        await suppressEmail(account.userId, email, "opt_out");
        return "reply_do_not_contact";
      }
      // Real human reply → responded + pause the sequence (cross-nothing here,
      // email-only, but the same call point would fan out to other channels).
      await db
        .updateTable("crm_contacts")
        .set({ outreach_status: "responded", outreach_status_at: new Date() })
        .where("id", "=", match.contactId)
        // Never downgrade a status that's already further along.
        .where((eb) => eb.or([eb("outreach_status", "is", null), eb("outreach_status", "in", ["queued", "contacted"])]))
        .execute();
      await pauseContactCampaigns(account.userId, match.contactId);
      return "reply_human";
    }

    case "EMAIL_BOUNCE": {
      // The docs never specified this field, and guessing wrong means hard
      // bounces silently never suppress. Read every plausible carrier and
      // treat "permanent"/5xx as hard too.
      const bounceHint = [
        p.bounce_type, p.bounceType, p.bounce_category, p.type, p.reason, p.bounce_reason,
      ].map((v) => String(v ?? "").toLowerCase()).join(" ");
      const smtpCode = String(p.smtp_code ?? p.code ?? "");
      const hard = /hard|permanent|invalid|does not exist|no such user|unknown user/.test(bounceHint)
        || /^5\d\d/.test(smtpCode);
      if (hard && email) {
        await suppressEmail(account.userId, email, "bounce_hard");
        return "bounce_hard";
      }
      // Soft bounces used to be logged and then ignored forever, so an address
      // that soft-bounces every send kept being mailed. Escalate on repetition:
      // this event row is already inserted, so count >= SOFT_BOUNCE_LIMIT means
      // we've now seen that many. Suppressed CRM-side only — no Smartlead
      // global unsubscribe, since a soft bounce isn't an opt-out.
      if (email) {
        const SOFT_BOUNCE_LIMIT = 3;
        const row = await db
          .selectFrom("outreach_events")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("user_id", "=", account.userId)
          .where("event_type", "=", "EMAIL_BOUNCE")
          .where((eb) => eb(eb.fn("lower", ["to_email"]), "=", email))
          .executeTakeFirst();
        if (Number(row?.n ?? 0) >= SOFT_BOUNCE_LIMIT) {
          await suppressEmail(account.userId, email, "bounce_soft");
          return "bounce_soft_escalated";
        }
      }
      return "bounce_soft"; // logged only
    }

    case "LEAD_UNSUBSCRIBED": {
      if (email) {
        // Opt-out of email is opt-out of you. (Cross-channel fan-out point.)
        await suppressEmail(account.userId, email, "opt_out");
        return "unsubscribed";
      }
      return "unsubscribed_no_email";
    }

    // Deliverability alarm — raised as an in-app alert, never as lead state.
    case "CAMPAIGN_BOUNCE_THRESHOLD":
    case "CAMPAIGN_BOUNCE_THRESHOLD_REACHED": {
      await alertUser(
        account.userId,
        `Smartlead's bounce threshold was reached on campaign ${campaignId ?? "?"}. Sending is likely ` +
        `auto-paused on their side. Check list quality before resuming.`,
        { kind: "bounce_threshold", severity: "critical", campaignId },
      );
      return "bounce_threshold_alerted";
    }

    default:
      return `ignored(${type})`;
  }
}
