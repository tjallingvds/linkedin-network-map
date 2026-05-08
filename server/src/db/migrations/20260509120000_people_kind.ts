import { sql, type Kysely } from "kysely";

/**
 * Tag rows in `people` with a kind so we can tell connections apart from
 * invitations after they've all been imported into the same table. Lets
 * the CRM filter contacts based on whether the user has already sent
 * them a LinkedIn connection request.
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE people ADD COLUMN IF NOT EXISTS kind TEXT`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS people_user_kind_idx ON people(user_id, kind)`.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS people_user_kind_idx`.execute(db);
  await sql`ALTER TABLE people DROP COLUMN IF EXISTS kind`.execute(db);
}
