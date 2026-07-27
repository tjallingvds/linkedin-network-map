/**
 * The inverse of the send filter: everyone who will NOT reach the approval
 * screen, and why, in words the operator can act on.
 *
 * This exists to answer one question — "why isn't everybody in the queue?" —
 * so it walks the same checks, in the same order, that decide who gets there:
 *
 *     board switched on
 *   → contact has an email, isn't suppressed, hasn't replied or been emailed
 *   → contact is in a group
 *   → that group is live (described, written, tested, switched on)
 *   → that group points at an active campaign
 *   → their name can produce a greeting
 *   → they aren't a duplicate of someone earlier in the list
 *
 * Anyone who passes all of that IS on the approval screen, so they are
 * deliberately absent from here. The two lists together account for every
 * contact on the board — there is a test asserting exactly that, because a
 * person who is in neither is a person who has silently vanished.
 */
import { db } from "../../db/index.js";
import { normalizeEmail } from "./suppress.js";
import { deriveName } from "./names.js";
import { listGroups, blockers } from "./groups.js";

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

export async function selectExcluded(userId: string, boardId: string): Promise<ExcludedContact[]> {
  const board = await db
    .selectFrom("crm_boards").select(["outreach_enabled"])
    .where("id", "=", boardId).where("user_id", "=", userId).executeTakeFirst();

  const contacts = await db
    .selectFrom("crm_contacts")
    .select(["id", "name", "email", "stage", "tier", "outreach_status",
             "linkedin", "opening_line_status", "opening_line_source"])
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

  const groups = new Map((await listGroups(boardId)).map((g) => [g.id, g]));
  const withCampaign = new Set(
    (await db.selectFrom("outreach_campaigns").select(["tier", "state"])
      .where("board_id", "=", boardId).where("state", "=", "active").execute())
      .map((c) => c.tier),
  );

  const readable: Record<string, string> = {
    opt_out: "unsubscribed", bounce_hard: "email bounced",
    bounce_soft: "kept bouncing", compliance: "compliance block", manual: "manually blocked",
  };

  const out: ExcludedContact[] = [];
  // Emails already claimed by someone who WILL be queued. The sender dedupes
  // by address, so the second row with the same email is the one dropped.
  const claimed = new Set<string>();

  for (const c of contacts) {
    const email = c.email ? normalizeEmail(c.email) : null;
    let reason: string | null = null;
    let fixable = false;

    const domain = email ? email.slice(email.lastIndexOf("@") + 1) : "";
    const blockedDomain = email
      ? [...supDomain.keys()].find((d) => domain === d || domain.endsWith(`.${d}`))
      : undefined;
    const group = c.tier ? groups.get(c.tier) : undefined;

    if (!email) { reason = "No email address"; fixable = true; }
    else if (supEmail.has(email)) reason = `Never contact — ${readable[supEmail.get(email)!] ?? supEmail.get(email)!}`;
    else if (blockedDomain) reason = `Never contact — ${blockedDomain} is blocked`;
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
    else if (!board?.outreach_enabled) { reason = "Sending is off for this board"; fixable = true; }
    else if (!c.tier) { reason = "No group chosen"; fixable = true; }
    else if (!group) { reason = "Their group no longer exists"; fixable = true; }
    else if (!group.live) {
      // Say which step is missing, not just "not live" — that's the whole
      // difference between a dead end and a to-do.
      reason = `Group “${group.name}” isn’t live — ${blockers(group)[0]}`;
      fixable = true;
    }
    else if (!withCampaign.has(c.tier)) {
      reason = `Group “${group.name}” has no Smartlead campaign`;
      fixable = true;
    }
    else if (deriveName(c.name).first === null) { reason = "Name can't be used in a greeting"; fixable = true; }
    else if (claimed.has(email)) { reason = "Same email as an earlier contact"; fixable = true; }
    // Past the gate — so whether they're on the approval screen comes down to
    // their opening line, which is written from their LinkedIn.
    else if (!c.linkedin?.trim()) { reason = "No LinkedIn link on their contact"; fixable = true; }
    else if (c.opening_line_status === "approved") reason = "Approved — going out now";
    else if (c.opening_line_status === "skipped") {
      reason = c.opening_line_source?.startsWith("Nothing usable")
        ? "Couldn't read their LinkedIn"
        : "Nothing specific enough on their LinkedIn";
      fixable = true;
    }
    else if (!c.opening_line_status) { reason = "Opening line still being written"; fixable = false; }

    if (reason) out.push({ id: c.id, name: c.name, email: c.email, stage: c.stage, reason, fixable });
    else if (email) claimed.add(email);
  }
  return out;
}
