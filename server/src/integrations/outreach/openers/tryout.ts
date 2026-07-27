/**
 * Trying a group's opening-line instructions on real people before it sends.
 *
 * The instructions are the one part of the setup you cannot check by reading
 * it — you have to see what it writes. So a group has to be tried on people
 * who are actually in it, and the results looked at, before it can go live.
 *
 * Nothing here is saved to the contacts. A test is a preview: same prompt,
 * same research, same campaign email, same model — but the lines are returned
 * and thrown away, so testing can never quietly fill the approval queue or
 * overwrite a line someone already approved.
 */
import { db } from "../../../db/index.js";
import type { UserKeys } from "../../../ai/user-keys.js";
import { availableProviders } from "../../../ai/providers.js";
import { getCampaignFirstEmail } from "../../smartlead.js";
import { getAccountByBoard } from "../accounts.js";
import { findGroup, markTested } from "../groups.js";
import { contextFor } from "./context.js";
import { research } from "./research.js";
import { draftOne, promptFor } from "./draft.js";

export interface Tryout {
  contactId: string;
  name: string;
  title: string | null;
  company: string | null;
  /** The line the instructions produced, or null when there was too little
   *  to say — which is a correct answer, not a failure. */
  line: string | null;
  /** Where the facts came from, so a wrong line is traceable. */
  from: string;
  error?: string;
}

export interface TryoutResult { groupName: string; sampled: number; lines: Tryout[] }

/** How many people to try. Enough to judge a prompt, few enough to be quick. */
const SAMPLE = 3;

/**
 * Write sample lines for up to three people in the group and record that the
 * current instructions were tested.
 *
 * Deliberately samples people who are IN the group rather than any contact:
 * the whole point is to see what this prompt does to this audience.
 */
export async function tryoutGroup(
  userId: string,
  boardId: string,
  groupId: string,
  opts: { userKeys?: UserKeys; onProgress?: (note: string) => void } = {},
): Promise<TryoutResult> {
  const group = await findGroup(boardId, groupId);
  if (!group) throw new Error("group_not_found");
  if (!group.prompt.trim()) throw new Error("Write the opening-line instructions first.");

  const contacts = await db
    .selectFrom("crm_contacts")
    .select([
      "id", "name", "title", "company", "notes", "background",
      "message_notes", "custom_fields", "linkedin",
    ])
    .where("user_id", "=", userId)
    .where("board_id", "=", boardId)
    .where("tier", "=", groupId)
    .where("email", "is not", null)
    .orderBy("created_at", "asc")
    .limit(SAMPLE)
    .execute();

  if (!contacts.length) {
    throw new Error("Nobody is in this group yet — sort people in first, then test.");
  }
  // Say this once, in words the operator can act on, rather than letting every
  // line fail with a provider error.
  if (!availableProviders(opts.userKeys).length) {
    throw new Error("Add an AI key under Manage API keys before testing.");
  }

  // The same campaign email the real run would write against, so the test
  // reflects what would actually be sent.
  let campaignEmail: { subject: string; body: string } | null = null;
  const campaign = await db
    .selectFrom("outreach_campaigns").select("provider_campaign_id")
    .where("board_id", "=", boardId).where("tier", "=", groupId).where("state", "=", "active")
    .executeTakeFirst();
  const account = await getAccountByBoard(boardId);
  if (campaign && account) {
    campaignEmail = await getCampaignFirstEmail(campaign.provider_campaign_id, account.apiKey);
  }

  const prompt = promptFor(group.prompt);
  const lines: Tryout[] = [];
  let i = 0;
  for (const c of contacts) {
    i++;
    opts.onProgress?.(`writing ${i}/${contacts.length}`);
    const { facts, sources } = contextFor(c as never);
    const found = await research(c as never, userId, opts.userKeys);
    found.snippets.forEach((sn, idx) => {
      facts[`web_${idx + 1}`] = `${sn.title} — ${sn.content}`;
      sources.push(sn.url || found.note);
    });

    const base = { contactId: c.id, name: c.name, title: c.title, company: c.company };
    // Same rule as the real run: no LinkedIn, no line.
    if (!found.snippets.length) {
      lines.push({ ...base, line: null, from: `Nothing usable — ${found.note}` });
      continue;
    }
    try {
      const { line, used } = await draftOne(facts, userId, opts.userKeys, campaignEmail, prompt);
      const from = (used.length ? used : sources)
        .map((k) => k.replace(/^custom_/, "").replace(/_/g, " "))
        .filter((v, idx, a) => a.indexOf(v) === idx)
        .join(", ");
      lines.push({ ...base, line, from: from || found.note });
    } catch (err) {
      lines.push({ ...base, line: null, from: "", error: (err as Error).message });
    }
  }

  // Only a run that actually reached the model counts as a test — otherwise a
  // group with no AI key configured could be waved through.
  if (lines.some((l) => l.error)) {
    throw new Error(lines.find((l) => l.error)!.error!);
  }
  await markTested(userId, boardId, groupId);

  return { groupName: group.name, sampled: contacts.length, lines };
}
