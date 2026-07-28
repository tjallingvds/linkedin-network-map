/**
 * Writing the line: the prompt, one-shot drafting, and the batch/auto runs.
 *
 * The hard rule lives in the prompt: never invent. A thin record must come back
 * as `null` and be marked `skipped` rather than given a plausible-sounding but
 * fabricated hook.
 */
import { db } from "../../../db/index.js";
import { aiJson } from "../../../ai/json.js";
import { availableProviders } from "../../../ai/providers.js";
import type { UserKeys } from "../../../ai/user-keys.js";
import { getCampaignFirstEmail } from "../../smartlead.js";
import { getAccountByBoard } from "../accounts.js";
import { research } from "./research.js";
import { sortAll } from "./sort.js";
import { findGroup } from "../groups.js";

export const DEFAULT_PROMPT = `You write the FIRST LINE of a cold B2B email.

Rules, in order of importance:
1. Use ONLY the facts given to you. Never invent achievements, funding, news,
   podcasts, posts, quotes, mutual connections, or anything not present.
2. If the facts are too thin to say something specific and TRUE about this
   person, return {"line": null}. Returning null is the correct, expected
   answer for a thin record — do not stretch.
3. One sentence. Maximum 25 words. Plain and specific.
4. No flattery ("impressive", "love what you're doing"), no "I hope this finds
   you well", no exclamation marks, no questions, no pitch, no sign-off.
5. Reference the specific thing, not the job title. "CTO at Acme" is not
   personal; a detail from the notes is.

6. LINKEDIN is their profile page, and it is the only material you have. The
   line must be about something on it. WHO is just the person's name, so you
   can tell which person the page is about — it is not something to write
   about. If LINKEDIN is empty, return {"line": null}.

7. You are given THE_EMAIL — the campaign email this line will sit on top of.
   The line must lead naturally into it: same register, no repetition of what
   the email already says, and no contradiction of it. Do not summarise or
   restate the email; just open it.

Return strict JSON: {"line": string|null, "used": string[]}
"used" lists which supplied fact keys you actually relied on.`;

/** The rules the model must always obey, appended to any custom prompt so a
 *  board can change the voice without being able to switch off "never invent"
 *  or the JSON contract the caller depends on. */
const NON_NEGOTIABLE = `

Always obey, regardless of any instruction above:
- Use ONLY the supplied facts. Never invent anything.
- Base the line on LINKEDIN. If LINKEDIN is empty, return {"line": null}.
- If there is nothing specific and TRUE to say, return {"line": null}.
- One sentence, no greeting, no sign-off, no pitch.
- Return strict JSON: {"line": string|null, "used": string[]}`;

/**
 * The instructions for one group: its own, or the built-in prompt. Whatever
 * wins, the non-negotiable rules are appended — a custom prompt can change the
 * voice, never switch off "never invent" or the JSON contract.
 */
export function promptFor(...candidates: Array<string | null | undefined>): string {
  const c = candidates.map((x) => (x ?? "").trim()).find((x) => x.length > 0);
  return c ? c + NON_NEGOTIABLE : DEFAULT_PROMPT;
}

/** Draft one line. Returns null when there isn't enough to say. */
export async function draftOne(
  facts: Record<string, string>,
  userId: string,
  userKeys?: UserKeys,
  email?: { subject: string; body: string } | null,
  /** Already-resolved instructions (see promptFor). Omit for the built-in. */
  prompt?: string | null,
): Promise<{ line: string | null; used: string[] }> {
  const providers = availableProviders(userKeys);
  if (!providers.length) throw new Error("no_ai_provider");
  const provider = providers[0]!;
  // Only the profile. The CRM's own columns used to be sent alongside, which
  // just handed the model other things to write about — and a line about a
  // city or a job title is the mail-merge this feature exists to avoid. The
  // name comes too, and only so the model can tell which person a page is
  // about when it covers more than one.
  const payload = {
    THE_EMAIL: email ? { subject: email.subject, body: email.body } : null,
    WHO: facts.name ?? null,
    LINKEDIN: Object.entries(facts).filter(([k]) => k.startsWith("web_")).map(([, v]) => v),
  };
  const out = await aiJson<{ line?: string | null; used?: string[] }>(
    provider,
    (prompt ?? "").trim() || DEFAULT_PROMPT,
    JSON.stringify(payload),
    { maxTokens: 300, userId, userKeys },
  );
  const line = typeof out?.line === "string" ? out.line.trim() : null;
  return { line: line && line.length > 0 ? line : null, used: Array.isArray(out?.used) ? out.used : [] };
}

export interface DraftResult { considered: number; drafted: number; skipped: number; failed: number }
/** Plus which groups were passed over, so "nothing happened" can say why. */
export interface AutodraftResult extends DraftResult { notLive: string[] }

/**
 * Draft opening lines for everyone in a group on this board who doesn't have
 * one yet. Existing approved lines are never overwritten.
 */
export async function draftOpeners(
  userId: string,
  boardId: string,
  group: string,
  opts: { userKeys?: UserKeys; onProgress?: (note: string) => void; redraft?: boolean } = {},
): Promise<DraftResult> {
  let q = db
    .selectFrom("crm_contacts")
    .select([
      "id", "name", "title", "company", "notes", "background",
      "message_notes", "custom_fields", "linkedin", "opening_line_status",
    ])
    .where("user_id", "=", userId)
    .where("board_id", "=", boardId)
    .where("tier", "=", group)
    .where("email", "is not", null);
  if (!opts.redraft) {
    // Leave anything already drafted or approved alone.
    q = q.where((eb) => eb.or([
      eb("opening_line_status", "is", null),
      eb("opening_line_status", "=", "skipped"),
    ]));
  }
  const contacts = await q.execute();

  // Instructions belong to the group. There is no board-wide prompt: one brief
  // for every audience is the thing groups exist to avoid.
  const groupRow = await findGroup(boardId, group);
  const prompt = promptFor(groupRow?.prompt);

  let campaignEmail: { subject: string; body: string } | null = null;
  const campaign = await db
    .selectFrom("outreach_campaigns").select("provider_campaign_id")
    .where("board_id", "=", boardId).where("tier", "=", group).where("state", "=", "active")
    .executeTakeFirst();
  const account = await getAccountByBoard(boardId);
  if (campaign && account) {
    campaignEmail = await getCampaignFirstEmail(campaign.provider_campaign_id, account.apiKey);
    if (!campaignEmail) console.warn(`[openers] no readable sequence for campaign ${campaign.provider_campaign_id}`);
  }

  const result: DraftResult = { considered: contacts.length, drafted: 0, skipped: 0, failed: 0 };
  if (!contacts.length) return result;
  if (!availableProviders(opts.userKeys).length) {
    throw new Error("Add an AI key under Manage API keys before drafting.");
  }

  let i = 0;
  for (const c of contacts) {
    i++;
    opts.onProgress?.(`drafting ${i}/${contacts.length}`);
    // Their profile, and nothing else. The name rides along only so the model
    // can tell which person a page is about.
    const found = await research(c as never, userId, opts.userKeys);
    const facts: Record<string, string> = { name: c.name };
    const sources: string[] = [];
    found.snippets.forEach((sn, idx) => {
      facts[`web_${idx + 1}`] = `${sn.title} — ${sn.content}`;
      sources.push(sn.url || found.note);
    });

    // The line is written from their LinkedIn. Without it there is nothing to
    // write from — falling back to CRM notes would produce a line that isn't
    // what was asked for, and the operator would have no way to tell.
    if (!found.snippets.length) {
      await db.updateTable("crm_contacts").set({
        opening_line: null,
        opening_line_source: `Nothing usable — ${found.note}`,
        opening_line_status: "skipped",
        opening_line_at: new Date(),
      }).where("id", "=", c.id).execute();
      result.skipped++;
      continue;
    }

    try {
      const { line, used } = await draftOne(facts, userId, opts.userKeys, campaignEmail, prompt);
      if (!line) {
        await db.updateTable("crm_contacts").set({
          opening_line: null,
          opening_line_source: "Nothing specific enough to reference",
          opening_line_status: "skipped",
          opening_line_at: new Date(),
        }).where("id", "=", c.id).execute();
        result.skipped++;
        continue;
      }
      // Where it came from is the profile itself; `used` names the fact keys,
      // which are all web_N now, so the URL is the useful answer.
      void used;
      const from = [...new Set(sources)].join(", ");
      await db.updateTable("crm_contacts").set({
        opening_line: line,
        opening_line_source: from || sources.join(", "),
        opening_line_status: "draft",
        opening_line_at: new Date(),
      }).where("id", "=", c.id).execute();
      result.drafted++;
    } catch (err) {
      console.error(`[openers] ${c.id} failed:`, (err as Error).message);
      result.failed++;
    }
  }
  return result;
}

/**
 * Write the missing lines everywhere at once: every switched-on board, every
 * group that has a campaign. This is the "autodraft" — the operator never
 * presses a per-group button, they just find the queue filled in.
 *
 * Runs sequentially on purpose. Each contact costs a Tavily lookup and an LLM
 * call, so this is deliberately not parallelised across a whole workspace.
 */
export async function autodraftAll(
  userId: string,
  opts: { userKeys?: UserKeys; onProgress?: (note: string) => void } = {},
): Promise<AutodraftResult> {
  // Sort anyone still ungrouped first — a person with no group can't be
  // drafted for, because the group decides which campaign email the line
  // has to lead into.
  try {
    const s = await sortAll(userId, {
      userKeys: opts.userKeys,
      onProgress: (n) => opts.onProgress?.(`grouping — ${n}`),
    });
    if (s.sorted) opts.onProgress?.(`sorted ${s.sorted} into groups`);
  } catch (err) {
    console.error("[openers] sorting failed, drafting anyway:", (err as Error).message);
  }

  const targets = await db
    .selectFrom("outreach_campaigns as oc")
    .innerJoin("crm_boards as b", "b.id", "oc.board_id")
    .select(["oc.board_id as board_id", "oc.tier as tier"])
    .where("oc.user_id", "=", userId)
    .where("oc.state", "=", "active")
    .where("b.outreach_enabled", "=", true)
    .execute();

  const total: AutodraftResult = { considered: 0, drafted: 0, skipped: 0, failed: 0, notLive: [] };
  let i = 0;
  for (const t of targets) {
    i++;
    // A group that can't send doesn't get lines written for it: every one
    // costs a web lookup and a model call, and nobody could act on them.
    const g = await findGroup(t.board_id, t.tier);
    if (!g?.live) { total.notLive.push(g?.name ?? t.tier); continue; }
    const r = await draftOpeners(userId, t.board_id, t.tier, {
      userKeys: opts.userKeys,
      onProgress: (n) => opts.onProgress?.(`group ${i}/${targets.length} — ${n}`),
    });
    total.considered += r.considered;
    total.drafted += r.drafted;
    total.skipped += r.skipped;
    total.failed += r.failed;
  }
  return total;
}
