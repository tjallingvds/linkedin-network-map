/**
 * Writing opening lines ahead of time.
 *
 * By the time somebody appears on the approval screen their line should
 * already be written and waiting — the screen is for deciding, not for
 * watching a model type. Drafting on open meant the first person to look sat
 * through it; anyone sorted into a group overnight was still undrafted.
 *
 * So this runs on the background tick: for every user with a live group, write
 * the lines that are missing. The approval screen keeps its catch-up pass for
 * anyone sorted in since, which should normally find nothing to do.
 *
 * Uses only keys stored on the account owner, because a background run has no
 * request to read per-user keys from. A user whose keys live only in their
 * session simply gets drafted when they next open the screen.
 */
import { db } from "../../../db/index.js";
import { autodraftAll } from "./draft.js";

/** Users who own at least one switched-on board with a mapped campaign. */
async function usersWithSending(): Promise<string[]> {
  const rows = await db
    .selectFrom("outreach_campaigns as oc")
    .innerJoin("crm_boards as b", "b.id", "oc.board_id")
    .select("oc.user_id as userId")
    .where("oc.state", "=", "active")
    .where("b.outreach_enabled", "=", true)
    .distinct()
    .execute();
  return rows.map((r) => r.userId);
}

export interface AheadResult { users: number; drafted: number; skipped: number; failed: number }

export async function draftAhead(): Promise<AheadResult> {
  const total: AheadResult = { users: 0, drafted: 0, skipped: 0, failed: 0 };
  for (const userId of await usersWithSending()) {
    total.users++;
    try {
      const r = await autodraftAll(userId);
      total.drafted += r.drafted;
      total.skipped += r.skipped;
      total.failed += r.failed;
    } catch (err) {
      // A user with no AI key configured throws; that's their setup, not a
      // reason to stop drafting for everyone else.
      console.warn(`[openers] ahead-of-time draft skipped for ${userId}:`, (err as Error).message);
    }
  }
  return total;
}
