/**
 * Reading and resolving the review queue: per board+group, and the global
 * "needs approval" list spanning every board.
 */
import { db } from "../../../db/index.js";
import { selectEligible } from "../gate.js";
import { deriveName } from "../names.js";
import { listGroups } from "../groups.js";

export interface OpenerRow {
  id: string;
  name: string;
  company: string | null;
  title: string | null;
  email: string | null;
  openingLine: string | null;
  source: string | null;
  status: string | null;
}

/**
 * Hand-edit a line. An edit returns it to `draft` so it is approved knowingly.
 * Returns false when the contact isn't the caller's — which the route turns
 * into a 404, so ownership is enforced by the same query that writes.
 */
export async function setOpener(userId: string, contactId: string, line: string): Promise<boolean> {
  const text = line.trim();
  const r = await db.updateTable("crm_contacts").set({
    opening_line: text || null,
    opening_line_source: "Written by you",
    opening_line_status: text ? "draft" : "skipped",
    opening_line_at: new Date(),
  }).where("id", "=", contactId).where("user_id", "=", userId).executeTakeFirst();
  return Number(r.numUpdatedRows ?? 0) > 0;
}

export interface PendingRow extends OpenerRow {
  boardId: string;
  boardName: string;
  group: string;
  /** The group's name as the operator wrote it — ids are internal. */
  groupName: string;
}

/** Every board+group that could actually send: switched on, campaign chosen. */
async function sendableTargets(userId: string) {
  const rows = await db
    .selectFrom("outreach_campaigns as oc")
    .innerJoin("crm_boards as b", "b.id", "oc.board_id")
    .select(["oc.board_id as boardId", "b.name as boardName", "oc.tier as group"])
    .where("oc.user_id", "=", userId)
    .where("oc.state", "=", "active")
    .where("b.outreach_enabled", "=", true)
    .orderBy("b.name", "asc")
    .execute();

  // Attach each group's display name, one board lookup per board.
  const names = new Map<string, string>();
  for (const boardId of new Set(rows.map((r) => r.boardId))) {
    for (const g of await listGroups(boardId)) names.set(`${boardId}|${g.id}`, g.name);
  }
  return rows.map((r) => ({ ...r, groupName: names.get(`${r.boardId}|${r.group}`) ?? r.group }));
}

/**
 * Everyone across EVERY board who is waiting for a yes or no, with the line
 * that was written for them.
 *
 * Only people whose line is WRITTEN AND NOT YET DECIDED appear here. That is
 * the whole meaning of the screen:
 *   - no line written yet  → not ready, so not shown (it's being written)
 *   - line couldn't be written → shown under "who won't be emailed" instead
 *   - already approved     → the decision is made, so it leaves immediately,
 *                            without waiting for the push to Smartlead
 *
 * Built on `selectEligible` rather than its own query, so the queue can never
 * disagree with what sending actually does: if someone is suppressed, already
 * in a campaign, or in a group that isn't live, they simply aren't here.
 */
export async function listPending(userId: string): Promise<PendingRow[]> {
  const out: PendingRow[] = [];

  for (const t of await sendableTargets(userId)) {
    // Anyone whose name can't produce a usable greeting is held back by the
    // sender too, so showing them here would offer an approval that silently
    // does nothing. They surface on the board under "who won't be emailed",
    // where the fix (edit the name) actually lives.
    const ready = (await selectEligible(userId, { tier: t.group, boardId: t.boardId }))
      .filter((r) => deriveName(r.name).first !== null);
    if (!ready.length) continue;

    const meta = await db
      .selectFrom("crm_contacts")
      .select(["id", "title", "opening_line", "opening_line_source", "opening_line_status"])
      .where("id", "in", ready.map((r) => r.id))
      // Written, and still undecided.
      .where("opening_line_status", "=", "draft")
      .where("opening_line", "is not", null)
      .execute();
    const byId = new Map(meta.map((m) => [m.id, m]));

    for (const r of ready) {
      const m = byId.get(r.id);
      if (!m) continue; // no line yet, or already decided
      out.push({
        id: r.id,
        name: r.name,
        company: r.company,
        title: m?.title ?? null,
        email: r.email,
        openingLine: m?.opening_line ?? null,
        source: m?.opening_line_source ?? null,
        status: m?.opening_line_status ?? null,
        boardId: t.boardId,
        boardName: t.boardName,
        group: t.group,
        groupName: t.groupName,
      });
    }
  }
  return out;
}

/** Badge number — how many people are waiting to be approved and sent. */
export async function pendingCount(userId: string): Promise<number> {
  return (await listPending(userId)).length;
}

/**
 * Approve the chosen people and report which board+group each belongs to.
 *
 * Marking the line approved is what removes them from the queue — it happens
 * here, before the push to Smartlead is even started, so pressing Approve
 * takes them off the screen immediately rather than leaving them sitting there
 * until a background job finishes.
 */
export async function approveByIds(
  userId: string,
  ids: string[],
): Promise<{ board: string; group: string; ids: string[] }[]> {
  if (!ids.length) return [];

  const targets = await db
    .selectFrom("crm_contacts")
    .select(["id", "board_id", "tier"])
    .where("user_id", "=", userId)
    .where("id", "in", ids)
    .execute();

  // Only rows that actually carry a drafted line need approving.
  await db.updateTable("crm_contacts")
    .set({ opening_line_status: "approved", opening_line_at: new Date() })
    .where("user_id", "=", userId)
    .where("id", "in", ids)
    .where("opening_line_status", "=", "draft")
    .where("opening_line", "is not", null)
    .execute();

  const groups = new Map<string, { board: string; group: string; ids: string[] }>();
  for (const t of targets) {
    if (!t.tier) continue;
    const key = `${t.board_id}|${t.tier}`;
    if (!groups.has(key)) groups.set(key, { board: t.board_id, group: t.tier, ids: [] });
    groups.get(key)!.ids.push(t.id);
  }
  return [...groups.values()];
}

/**
 * How many sendable people still have no line written. Drives the catch-up
 * draft when the approval screen opens; the background pass normally means
 * this is already zero by the time anyone looks.
 */
export async function undraftedCount(userId: string): Promise<number> {
  let n = 0;
  for (const t of await sendableTargets(userId)) {
    const ready = (await selectEligible(userId, { tier: t.group, boardId: t.boardId }))
      .filter((r) => deriveName(r.name).first !== null);
    if (!ready.length) continue;
    const rows = await db
      .selectFrom("crm_contacts").select("id")
      .where("id", "in", ready.map((r) => r.id))
      .where("opening_line_status", "is", null)
      .execute();
    n += rows.length;
  }
  return n;
}
