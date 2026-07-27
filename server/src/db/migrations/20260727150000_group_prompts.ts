/**
 * Opening-line instructions move from the board to each group.
 *
 * A board-wide prompt meant every audience got the same opener brief, which
 * defeats the point of having groups at all. Instructions now live on the
 * group, and the board-level editor is gone.
 *
 * Anything already written at board level is copied into that board's groups
 * that have no instructions of their own, so nothing typed is lost. The
 * `opening_prompt` column is left in place holding what it held — dropping it
 * would destroy the original if this needs to be reversed.
 *
 * Groups also gain `testedAt` and `live`. Both start empty/false, which means
 * every existing group is not live until its instructions have been written
 * and tried on real people. That is the safe direction: this migration can
 * only stop email going out, never start it.
 */
import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  const boards = await db
    .selectFrom("crm_boards").select(["id", "outreach_groups", "opening_prompt"]).execute();

  for (const board of boards) {
    if (!Array.isArray(board.outreach_groups)) continue;
    const inherited = (board.opening_prompt ?? "").trim();

    const groups = (board.outreach_groups as Array<Record<string, unknown>>).map((g) => {
      const own = typeof g.prompt === "string" ? g.prompt.trim() : "";
      return {
        id: g.id,
        name: g.name,
        description: g.description ?? "",
        prompt: own || inherited,
        testedAt: null,
        live: false,
      };
    });

    await db
      .updateTable("crm_boards")
      .set({ outreach_groups: sql`${JSON.stringify(groups)}::jsonb` })
      .where("id", "=", board.id)
      .execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // Drop the fields this migration added; the prompts stay on the groups and
  // `opening_prompt` was never cleared, so nothing is lost either way.
  const boards = await db
    .selectFrom("crm_boards").select(["id", "outreach_groups"]).execute();

  for (const board of boards) {
    if (!Array.isArray(board.outreach_groups)) continue;
    const groups = (board.outreach_groups as Array<Record<string, unknown>>).map((g) => ({
      id: g.id, name: g.name, description: g.description ?? "", prompt: g.prompt ?? "",
    }));
    await db
      .updateTable("crm_boards")
      .set({ outreach_groups: sql`${JSON.stringify(groups)}::jsonb` })
      .where("id", "=", board.id)
      .execute();
  }
}
