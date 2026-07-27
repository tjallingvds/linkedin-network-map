/**
 * Groups become a list you can add to.
 *
 * They were three fixed slots (A, B, C) and `outreach_groups` held a map of
 * descriptions keyed by those letters. Now a board keeps an ordered list of
 * groups, each with its own name, description and opening-line instructions,
 * and `crm_contacts.tier` / `outreach_campaigns.tier` hold the group's id.
 *
 * The letters are kept as ids for everything that already exists, so no
 * contact loses its group and no campaign mapping breaks. A board that was
 * using letters without ever describing them still gets its groups listed —
 * built from whichever letters its contacts and campaigns actually use — so
 * nothing silently disappears from the screen.
 */
import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  const boards = await db
    .selectFrom("crm_boards").select(["id", "outreach_groups"]).execute();

  for (const board of boards) {
    const raw = board.outreach_groups;
    if (Array.isArray(raw)) continue; // already a list

    const descriptions: Record<string, string> =
      raw && typeof raw === "object" ? (raw as Record<string, string>) : {};

    // Every letter this board actually uses, not just the described ones.
    const used = new Set<string>(Object.keys(descriptions));
    for (const t of ["crm_contacts", "outreach_campaigns"]) {
      const rows = await db
        .selectFrom(t as any).select("tier").distinct()
        .where("board_id", "=", board.id).where("tier", "is not", null).execute();
      for (const r of rows) if (r.tier) used.add(String(r.tier));
    }
    if (!used.size) continue; // board never touched outreach — leave it null

    const groups = [...used].sort().map((id) => ({
      id,
      name: `Group ${id}`,
      description: (descriptions[id] ?? "").trim(),
      prompt: "",
    }));

    await db
      .updateTable("crm_boards")
      .set({ outreach_groups: sql`${JSON.stringify(groups)}::jsonb` })
      .where("id", "=", board.id)
      .execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // Back to the description map. Per-group names and prompts are dropped —
  // the old shape had nowhere to put them.
  const boards = await db
    .selectFrom("crm_boards").select(["id", "outreach_groups"]).execute();

  for (const board of boards) {
    if (!Array.isArray(board.outreach_groups)) continue;
    const map: Record<string, string> = {};
    for (const g of board.outreach_groups as Array<Record<string, unknown>>) {
      const id = typeof g?.id === "string" ? g.id : "";
      const description = typeof g?.description === "string" ? g.description : "";
      if (id && description) map[id] = description;
    }
    await db
      .updateTable("crm_boards")
      .set({ outreach_groups: sql`${JSON.stringify(map)}::jsonb` })
      .where("id", "=", board.id)
      .execute();
  }
}
