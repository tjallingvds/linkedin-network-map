/**
 * Outreach groups: the list of audiences a board sends to.
 *
 * A group is what the operator writes, plus the state that decides whether it
 * is allowed to send:
 *   name         — what they call it ("Bank AI leads")
 *   description  — who belongs, in their words; this is what sorts people in
 *   prompt       — how this group's opening line is written
 *   testedAt     — when its prompt was last tried on real people in the group
 *   live         — whether it may send at all
 *   id           — stable, never shown; `crm_contacts.tier` and
 *                  `outreach_campaigns.tier` both hold it
 *
 * A group goes live only after its prompt has been written AND tried on real
 * people, because the prompt is the one thing nobody can check by reading it —
 * you have to see what it writes. Changing the prompt drops the group back out
 * of live, since the thing that was approved no longer exists. The rule is
 * enforced in the gate (see canSend / selectEligible), not just on screen.
 *
 * The list lives in `crm_boards.outreach_groups` rather than its own table
 * because it is small, always read whole, and edited as a unit — and because
 * a board with no list means "no groups", which is exactly the safe state:
 * nobody is sorted, so nobody is emailable.
 */
import { randomUUID } from "node:crypto";
import { db } from "../../db/index.js";

export interface OutreachGroup {
  id: string;
  name: string;
  description: string;
  prompt: string;
  /** ISO time the current prompt was last tested. Null = never, or the prompt
   *  changed since. */
  testedAt: string | null;
  /** Whether this group may send. Cannot be true without a tested prompt. */
  live: boolean;
}

/** How many groups one board may have. Generous, but not unbounded. */
export const MAX_GROUPS = 12;

export function newGroupId(): string {
  return randomUUID().slice(0, 8);
}

/** Coerce whatever is in the column into a clean list. */
export function parseGroups(raw: unknown): OutreachGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: OutreachGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const r = g as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id || out.some((x) => x.id === id)) continue;
    const prompt = (typeof r.prompt === "string" ? r.prompt : "").trim();
    const testedAt = typeof r.testedAt === "string" && r.testedAt ? r.testedAt : null;
    out.push({
      id,
      name: (typeof r.name === "string" ? r.name : "").trim() || `Group ${out.length + 1}`,
      description: (typeof r.description === "string" ? r.description : "").trim(),
      prompt,
      testedAt,
      // Live is never taken on trust from the stored value alone: an untested
      // or promptless group reads as not live however it was written.
      live: r.live === true && !!prompt && !!testedAt,
    });
  }
  return out.slice(0, MAX_GROUPS);
}

/** This board's groups, in the order the operator arranged them. */
export async function listGroups(boardId: string): Promise<OutreachGroup[]> {
  const board = await db
    .selectFrom("crm_boards").select("outreach_groups")
    .where("id", "=", boardId).executeTakeFirst();
  return parseGroups(board?.outreach_groups);
}

/** The named group, or null. */
export async function findGroup(boardId: string, groupId: string): Promise<OutreachGroup | null> {
  return (await listGroups(boardId)).find((g) => g.id === groupId) ?? null;
}

/** Groups that describe who belongs — the only ones the sorter may assign. */
export function describedGroups(groups: OutreachGroup[]): OutreachGroup[] {
  return groups.filter((g) => g.description.trim().length > 0);
}

/** What a group is still missing before it can send. Empty = ready. */
export function blockers(g: OutreachGroup): string[] {
  const out: string[] = [];
  if (!g.description.trim()) out.push("no description of who belongs");
  if (!g.prompt.trim()) out.push("no opening-line instructions");
  else if (!g.testedAt) out.push("instructions not tested yet");
  if (!g.live) out.push("not switched live");
  return out;
}

/** May this group send? The single question the gate asks. */
export async function canSend(boardId: string, groupId: string): Promise<boolean> {
  const g = await findGroup(boardId, groupId);
  return !!g && g.live && !!g.prompt.trim() && !!g.testedAt;
}

export interface SaveResult { groups: OutreachGroup[]; ungrouped: number }

/** Record that this group's current instructions were tried on real people. */
export async function markTested(userId: string, boardId: string, groupId: string): Promise<void> {
  const groups = await listGroups(boardId);
  const next = groups.map((g) => (g.id === groupId ? { ...g, testedAt: new Date().toISOString() } : g));
  await db.updateTable("crm_boards")
    .set({ outreach_groups: JSON.stringify(next) as never, updated_at: new Date() as never })
    .where("id", "=", boardId).where("user_id", "=", userId).execute();
}

/**
 * Replace the whole list.
 *
 * Removing a group is allowed and deliberately safe: its people lose their
 * group, which means they stop being eligible to send, and its campaign
 * mapping goes with it. Losing a group can only ever stop email going out,
 * never start it — so it needs no confirmation beyond the operator's own.
 */
export async function saveGroups(
  userId: string,
  boardId: string,
  incoming: Array<Partial<OutreachGroup>>,
): Promise<SaveResult> {
  const before = await listGroups(boardId);

  const groups: OutreachGroup[] = [];
  for (const g of incoming.slice(0, MAX_GROUPS)) {
    const id = typeof g.id === "string" && g.id.trim() ? g.id.trim() : newGroupId();
    if (groups.some((x) => x.id === id)) continue; // ignore a duplicated id
    const was = before.find((b) => b.id === id);
    const prompt = (g.prompt ?? "").trim().slice(0, 4000);

    // Changing the instructions invalidates the test: what was approved is not
    // what would now be written. The group drops out of live until it is tried
    // again. Only the prompt does this — renaming a group is harmless.
    const promptChanged = !!was && was.prompt !== prompt;
    const testedAt = promptChanged ? null : was?.testedAt ?? null;

    groups.push({
      id,
      name: (g.name ?? "").trim().slice(0, 80) || `Group ${groups.length + 1}`,
      description: (g.description ?? "").trim().slice(0, 1000),
      prompt,
      testedAt,
      // Live is a claim the caller makes and we check, never one we take.
      live: g.live === true && !!prompt && !!testedAt,
    });
  }

  const removed = before.filter((b) => !groups.some((g) => g.id === b.id)).map((g) => g.id);
  let ungrouped = 0;
  if (removed.length) {
    const res = await db
      .updateTable("crm_contacts")
      .set({ tier: null, group_reason: "Their group was removed" })
      .where("user_id", "=", userId).where("board_id", "=", boardId)
      .where("tier", "in", removed)
      .executeTakeFirst();
    ungrouped = Number(res.numUpdatedRows ?? 0);
    await db.deleteFrom("outreach_campaigns")
      .where("board_id", "=", boardId).where("tier", "in", removed).execute();
  }

  await db.updateTable("crm_boards")
    .set({ outreach_groups: JSON.stringify(groups) as never, updated_at: new Date() as never })
    .where("id", "=", boardId).where("user_id", "=", userId).execute();

  return { groups, ungrouped };
}
