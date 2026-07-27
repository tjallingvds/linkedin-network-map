/**
 * The inverse of the send filter: everyone who will NOT be emailed, and why,
 * in words the operator can act on.
 *
 * Computed from the same facts the filter uses, so the two can never disagree —
 * if someone is missing from a send, they appear here with the reason.
 */
import { db } from "../../db/index.js";
import { normalizeEmail } from "./suppress.js";
import { deriveName } from "./names.js";

export interface ExcludedContact {
  id: string;
  name: string;
  email: string | null;
  stage: string;
  /** Plain-language reason this person will not receive email. */
  reason: string;
  /** True when the operator can fix it themselves (add an email, pick a group). */
  fixable: boolean;
}

/**
 * The inverse of the gate: everyone on this board who will NOT be emailed, and
 * why. Deliberately computed from the same facts the gate uses, so the two can
 * never disagree — if someone is missing from an export, they appear here with
 * the reason.
 */
export async function selectExcluded(userId: string, boardId: string): Promise<ExcludedContact[]> {
  const contacts = await db
    .selectFrom("crm_contacts")
    .select(["id", "name", "email", "stage", "tier", "outreach_status", "opening_line_status"])
    .where("user_id", "=", userId)
    .where("board_id", "=", boardId)
    .orderBy("created_at", "asc")
    .execute();

  const suppressions = await db
    .selectFrom("suppressions").select(["scope", "value", "reason"])
    .where("user_id", "=", userId).execute();
  const supEmail = new Map(suppressions.filter((s) => s.scope === "email").map((s) => [s.value, s.reason]));
  const supDomain = new Map(suppressions.filter((s) => s.scope === "domain").map((s) => [s.value, s.reason]));

  const memberships = await db
    .selectFrom("outreach_campaign_memberships")
    .select(["contact_id", "state"])
    .where("user_id", "=", userId)
    .execute();
  const memberState = new Map(memberships.map((m) => [m.contact_id, m.state]));

  const readable: Record<string, string> = {
    opt_out: "unsubscribed", bounce_hard: "email bounced",
    bounce_soft: "kept bouncing", compliance: "compliance block", manual: "manually blocked",
  };

  const out: ExcludedContact[] = [];
  for (const c of contacts) {
    const email = c.email ? normalizeEmail(c.email) : null;
    let reason: string | null = null;
    let fixable = false;

    if (!email) { reason = "No email address"; fixable = true; }
    else if (supEmail.has(email)) reason = `Never contact — ${readable[supEmail.get(email)!] ?? supEmail.get(email)!}`;
    else {
      const domain = email.slice(email.lastIndexOf("@") + 1);
      const blockedDomain = [...supDomain.keys()].find((d) => domain === d || domain.endsWith(`.${d}`));
      if (blockedDomain) reason = `Never contact — ${blockedDomain} is blocked`;
      else if (c.outreach_status === "do_not_contact") reason = "Never contact";
      else if (c.outreach_status === "responded") reason = "They replied — sending stopped";
      else if (memberState.get(c.id) === "active") {
        reason = c.outreach_status === "queued"
          ? "Waiting for Smartlead to send the first email"
          : "Already being emailed";
      }
      else if (memberState.get(c.id) === "paused") reason = "Sending stopped";
      else if (memberState.get(c.id) === "blocked") reason = "Blocked at Smartlead";
      else if (c.outreach_status === "contacted") reason = "Already emailed";
      else if (!c.tier) { reason = "No group chosen"; fixable = true; }
      else if (deriveName(c.name).first === null) { reason = "Name can't be used in a greeting"; fixable = true; }
      else if (c.opening_line_status === "skipped") { reason = "Not enough info for a personal line"; fixable = true; }
      else if (!c.opening_line_status) { reason = "No personal line drafted yet"; fixable = true; }
      else if (c.opening_line_status === "draft") { reason = "Personal line waiting for your approval"; fixable = true; }
    }

    if (reason) out.push({ id: c.id, name: c.name, email: c.email, stage: c.stage, reason, fixable });
  }
  return out;
}
