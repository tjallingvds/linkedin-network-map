/**
 * Suppression levers (spec §4). Three actions, deliberately different in blast
 * radius:
 *   - pauseContactCampaigns   reversible, default; stops future steps
 *   - suppressEmail           permanent global unsubscribe (opt-out / hard bounce)
 *   - blockDomain             compliance stop for a whole organisation
 *
 * Credentials are per BOARD, so nothing here takes an API key: each membership
 * is resolved to its campaign's board and that board's account is used. A
 * contact duplicated across two boards is therefore paused in both, each
 * through its own Smartlead account.
 *
 * Every mutation writes the CRM first (system of record), then calls Smartlead.
 * A failed call is retried once immediately; the nightly reconciler is the
 * backstop. The DB write and the network call can't be one transaction, so the
 * ordering is deliberate: record intent, then enforce.
 */
import { db } from "../../db/index.js";
import {
  pauseLead,
  resumeLead,
  unsubscribeLeadGlobally,
  addDomainToBlockList,
  getLeadIdByEmail,
  SmartleadError,
} from "../smartlead.js";
import { getAccountByBoard } from "./accounts.js";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Retry a Smartlead call once immediately. Never throws into a webhook ack
 *  path — the reconciler catches whatever still fails. */
async function tryTwice(fn: () => Promise<unknown>, label: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await fn();
      return true;
    } catch (err) {
      if (err instanceof SmartleadError && err.status === 404) return true; // already gone
      if (attempt === 2) {
        console.error(`[outreach] ${label} failed after retry:`, (err as Error).message);
        return false;
      }
    }
  }
  return false;
}

async function setContactOutreachStatus(contactId: string, status: string): Promise<void> {
  await db
    .updateTable("crm_contacts")
    .set({ outreach_status: status, outreach_status_at: new Date() })
    .where("id", "=", contactId)
    .execute();
}

/** Memberships for a contact, each with the board that owns its campaign. */
function membershipsFor(contactId: string, states: string[]) {
  return db
    .selectFrom("outreach_campaign_memberships as cm")
    .innerJoin("outreach_campaigns as c", "c.id", "cm.campaign_id")
    .select([
      "cm.id as id", "cm.provider_campaign_id as provider_campaign_id",
      "cm.provider_lead_id as provider_lead_id", "c.board_id as board_id",
    ])
    .where("cm.contact_id", "=", contactId)
    .where("cm.state", "in", states)
    .execute();
}

/**
 * §4.1 Reversible pause. For every active membership of this contact, pause the
 * sequence using that membership's board account, then flip it to `paused`.
 * If we don't hold the provider_lead_id yet, resolve it by email first.
 */
export async function pauseContactCampaigns(userId: string, contactId: string): Promise<void> {
  const memberships = await membershipsFor(contactId, ["active"]);

  for (const m of memberships) {
    const account = await getAccountByBoard(m.board_id);
    let leadId = m.provider_lead_id;

    if (account && !leadId) {
      const contact = await db
        .selectFrom("crm_contacts").select("email").where("id", "=", contactId).executeTakeFirst();
      if (contact?.email) {
        leadId = await getLeadIdByEmail(normalizeEmail(contact.email), account.apiKey).catch(() => null);
        if (leadId) {
          await db.updateTable("outreach_campaign_memberships")
            .set({ provider_lead_id: leadId }).where("id", "=", m.id).execute();
        }
      }
    }

    if (account && leadId) {
      await tryTwice(() => pauseLead(m.provider_campaign_id, leadId as string, account.apiKey), `pause ${m.id}`);
    } else {
      console.warn(`[outreach] pause: ${!account ? "board not connected" : "no provider_lead_id"} for membership ${m.id}; CRM-only`);
    }
    // Reflect intent regardless — the gate must never re-add, and the
    // reconciler re-issues the pause if Smartlead still shows active.
    await db.updateTable("outreach_campaign_memberships")
      .set({ state: "paused", updated_at: new Date() as never }).where("id", "=", m.id).execute();
  }
}

/** Resume paused sequences for a contact (used when a lead returns to cold). */
export async function resumeContactCampaigns(contactId: string): Promise<void> {
  const memberships = await membershipsFor(contactId, ["paused"]);
  for (const m of memberships) {
    const account = await getAccountByBoard(m.board_id);
    if (account && m.provider_lead_id) {
      await tryTwice(
        () => resumeLead(m.provider_campaign_id, m.provider_lead_id as string, account.apiKey),
        `resume ${m.id}`,
      );
    }
    await db.updateTable("outreach_campaign_memberships")
      .set({ state: "active", updated_at: new Date() as never }).where("id", "=", m.id).execute();
  }
}

/**
 * §4.2 Permanent email suppression (opt-out / hard bounce). Records it, marks
 * every matching contact do_not_contact, and — for a genuine opt-out — issues
 * Smartlead's global unsubscribe on every board that has a lead id for them, so
 * they can't be re-added through any path that bypasses our gate.
 */
export async function suppressEmail(
  userId: string,
  emailRaw: string,
  reason: "opt_out" | "bounce_hard" | "bounce_soft" | "manual" | "compliance",
): Promise<void> {
  const email = normalizeEmail(emailRaw);
  await db
    .insertInto("suppressions")
    .values({ user_id: userId, scope: "email", value: email, reason })
    .onConflict((oc) => oc.columns(["user_id", "scope", "value"]).doNothing())
    .execute();

  const contacts = await db
    .selectFrom("crm_contacts").select(["id"]).where("user_id", "=", userId)
    .where((eb) => eb(eb.fn("lower", ["email"]), "=", email)).execute();
  for (const c of contacts) await setContactOutreachStatus(c.id, "do_not_contact");

  if (reason !== "opt_out" && reason !== "bounce_hard") return;

  // Per board: unsubscribe with that board's own key.
  const memberships = await db
    .selectFrom("outreach_campaign_memberships as cm")
    .innerJoin("outreach_campaigns as c", "c.id", "cm.campaign_id")
    .innerJoin("crm_contacts as ct", "ct.id", "cm.contact_id")
    .select(["cm.id as id", "cm.provider_lead_id as provider_lead_id", "c.board_id as board_id"])
    .where("cm.user_id", "=", userId)
    .where("cm.provider_lead_id", "is not", null)
    .where((eb) => eb(eb.fn("lower", ["ct.email"]), "=", email))
    .execute();

  let anySynced = false;
  for (const m of memberships) {
    const account = await getAccountByBoard(m.board_id);
    if (!account) continue;
    const ok = await tryTwice(
      () => unsubscribeLeadGlobally(m.provider_lead_id as string, account.apiKey),
      `unsubscribe ${m.provider_lead_id}`,
    );
    anySynced = anySynced || ok;
  }
  if (anySynced) {
    await db.updateTable("suppressions").set({ synced_at: new Date() })
      .where("user_id", "=", userId).where("scope", "=", "email").where("value", "=", email).execute();
  }

  await db.updateTable("outreach_campaign_memberships").set({ state: "blocked", updated_at: new Date() as never })
    .where("contact_id", "in", (qb) =>
      qb.selectFrom("crm_contacts").select("id").where("user_id", "=", userId)
        .where((eb) => eb(eb.fn("lower", ["email"]), "=", email)))
    .execute();
}

/**
 * §4.3 Domain block. Records the suppression, pushes Smartlead's domain block
 * list on every connected board (it's an account-level list, so each account
 * needs its own call), and marks everyone at that domain do_not_contact.
 */
export async function blockDomain(
  userId: string,
  domainRaw: string,
  reason: "compliance" | "manual",
): Promise<void> {
  const domain = domainRaw.trim().toLowerCase();
  await db
    .insertInto("suppressions")
    .values({ user_id: userId, scope: "domain", value: domain, reason })
    .onConflict((oc) => oc.columns(["user_id", "scope", "value"]).doNothing())
    .execute();

  const boards = await db
    .selectFrom("smartlead_accounts").select("board_id").where("user_id", "=", userId).execute();
  let synced = false;
  for (const b of boards) {
    const account = await getAccountByBoard(b.board_id);
    if (!account) continue;
    const ok = await tryTwice(() => addDomainToBlockList(domain, account.apiKey), `domain block ${domain}`);
    synced = synced || ok;
  }
  if (synced) {
    await db.updateTable("suppressions").set({ synced_at: new Date() })
      .where("user_id", "=", userId).where("scope", "=", "domain").where("value", "=", domain).execute();
  }

  const contacts = await db
    .selectFrom("crm_contacts").select(["id"]).where("user_id", "=", userId)
    .where((eb) => eb(eb.fn("lower", ["email"]), "like", `%@${domain}`)).execute();
  for (const c of contacts) {
    await setContactOutreachStatus(c.id, "do_not_contact");
    await pauseContactCampaigns(userId, c.id);
  }
}
