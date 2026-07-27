/**
 * Bridge from a human dragging a kanban card to the outreach engine.
 *
 * The model is deliberately one-way and simple: a board lists the stages that
 * mean "stop emailing these people". Drag a card into one of those and that
 * person's sequence is paused. Nothing auto-resumes — coming back out of a
 * stage does not restart emails, because silently resuming outreach at someone
 * is a far worse surprise than having to press resume yourself.
 *
 * Stage names are matched forgivingly: case, spacing and punctuation are
 * ignored, and a small edit distance is allowed, so a stage renamed to
 * "Meeting booked" or mistyped as "Meting booked" still stops sending.
 *
 * Always fire-and-forget: a Smartlead outage must never fail a card move.
 */
import { db } from "../../db/index.js";
import { pauseContactCampaigns } from "./suppress.js";

/** Stages that stop sending, as chosen on the board. */
export interface StageRules { noSend?: string[] }

/** Lowercase, strip punctuation, collapse whitespace. */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Levenshtein distance, short-circuited — we only care about "close". */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Are these the same stage? Tolerates case, punctuation and a typo or two, and
 * — the case that actually bites — an id written where a label is stored, or
 * the other way round. A board's stages live on the client, so both spellings
 * reach the server depending on which screen saved them.
 */
export function sameStage(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a ?? ""), y = norm(b ?? "");
  if (!x || !y) return false;
  if (x === y) return true;
  const budget = Math.max(x.length, y.length) >= 8 ? 2 : 1;
  return editDistance(x, y) <= budget;
}

/**
 * Does this stage mean "stop sending"? Tolerates case, punctuation and a typo
 * or two — failing to stop is the expensive direction, so matching leans
 * generous.
 */
export function stageStopsSending(stage: string | null | undefined, rules?: StageRules | null): boolean {
  if (!stage) return false;
  const list = rules?.noSend ?? [];
  if (!list.length) return false;
  const s = norm(stage);
  if (!s) return false;

  return list.some((raw) => {
    const t = norm(raw);
    if (!t) return false;
    if (s === t) return true;
    const budget = Math.max(t.length, s.length) >= 8 ? 2 : 1;
    return editDistance(s, t) <= budget;
  });
}

/**
 * React to a contact's stage change. Cheap-exits before touching Smartlead when
 * the board is off or the contact isn't currently sending.
 *
 * `editorId` is whoever moved the card (may be a shared-board collaborator).
 * The sequence belongs to the contact owner and the credentials belong to the
 * board — both resolved inside pauseContactCampaigns — so a collaborator's
 * move still acts on the right account.
 */
export async function onStageChange(editorId: string, contactId: string, newStage: string): Promise<void> {
  const board = await db
    .selectFrom("crm_contacts as c")
    .innerJoin("crm_boards as b", "b.id", "c.board_id")
    .select(["b.outreach_stage_map as rules", "b.outreach_enabled as enabled"])
    .where("c.id", "=", contactId)
    .executeTakeFirst();
  if (!board?.enabled) return;
  if (!stageStopsSending(newStage, (board.rules ?? null) as StageRules | null)) return;

  const live = await db
    .selectFrom("outreach_campaign_memberships")
    .select(["id", "user_id"])
    .where("contact_id", "=", contactId)
    .where("state", "=", "active")
    .executeTakeFirst();
  if (!live) return; // not currently sending — nothing to stop

  const contact = await db
    .selectFrom("crm_contacts").select("outreach_status").where("id", "=", contactId).executeTakeFirst();

  // Don't downgrade an opt-out; otherwise mark responded so the gate can't re-add.
  if (contact?.outreach_status !== "do_not_contact") {
    await db.updateTable("crm_contacts")
      .set({ outreach_status: "responded", outreach_status_at: new Date() })
      .where("id", "=", contactId)
      .where((eb) => eb.or([eb("outreach_status", "is", null), eb("outreach_status", "in", ["queued", "contacted"])]))
      .execute();
  }
  await pauseContactCampaigns(live.user_id, contactId);
}
