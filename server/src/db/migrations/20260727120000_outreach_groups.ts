/**
 * Automatic group sorting.
 *
 * Groups used to be a label you set by hand on every contact. Now you describe
 * what each group means once, on the board, and people are filed into them for
 * you — so this adds somewhere to keep the descriptions, and somewhere to keep
 * the reason each person ended up where they did.
 *
 * Both columns are nullable with no backfill: an existing board has no
 * descriptions, which means nothing is sorted until someone writes them. That
 * is the safe default — a group is what makes a contact emailable.
 */
import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("crm_boards")
    /** What each group means, in the operator's own words:
     *  { "A": "Heads of AI at tier-1 banks", "C": "…" }.
     *  A group with no description here is never assigned to anyone. */
    .addColumn("outreach_groups", "jsonb")
    .execute();

  await db.schema
    .alterTable("crm_contacts")
    /** Why the sorter put this person in their group — kept so a wrong call is
     *  visible and can be overruled by hand. */
    .addColumn("group_reason", "text")
    .execute();

  // The sorter reads every contact on a board that still has no group.
  await sql`
    CREATE INDEX IF NOT EXISTS crm_contacts_ungrouped_idx
    ON crm_contacts (user_id, board_id)
    WHERE tier IS NULL AND email IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS crm_contacts_ungrouped_idx`.execute(db);
  await db.schema.alterTable("crm_contacts").dropColumn("group_reason").execute();
  await db.schema.alterTable("crm_boards").dropColumn("outreach_groups").execute();
}
