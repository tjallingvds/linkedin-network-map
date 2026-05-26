import { sql, type Kysely } from "kysely";

/**
 * Hard deadlines tied to next_step ("send him the deck by Friday").
 * Powers the Overview "Deadlines" section — contacts with a populated
 * next_step_due_at surface with overdue / due-soon countdowns so the
 * user doesn't have to scan the whole pipeline for promises they made.
 *
 * Just one column. Existing next_step text is unchanged; this adds a
 * structured due-date next to it.
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS next_step_due_at timestamptz`.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE crm_contacts DROP COLUMN IF EXISTS next_step_due_at`.execute(db);
}
