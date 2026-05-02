import { sql, type Kysely } from "kysely";

/**
 * Move per-board table-column configuration off of each user's localStorage
 * and onto the board itself, so collaborators see the same columns, the
 * same labels, and the same row height. JSONB so we can evolve column
 * schemas without further migrations.
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS so re-running won't crash.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE crm_boards ADD COLUMN IF NOT EXISTS columns JSONB`.execute(db);
  await sql`ALTER TABLE crm_boards ADD COLUMN IF NOT EXISTS row_height TEXT`.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE crm_boards DROP COLUMN IF EXISTS columns`.execute(db);
  await sql`ALTER TABLE crm_boards DROP COLUMN IF EXISTS row_height`.execute(db);
}
