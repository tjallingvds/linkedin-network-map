import { sql, type Kysely } from "kysely";

/**
 * Store AI-generated background info per contact (recent posts, talks,
 * funny things they've said publicly — with source URLs). Separate from
 * `notes` and `message_notes` so the background auto-enrichment doesn't
 * clobber the user's own hand-typed context.
 *
 * Idempotent: uses ADD COLUMN IF NOT EXISTS so a partially-run earlier
 * migration (or a manually-added column) doesn't crash-loop server boot.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS background TEXT`.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE crm_contacts DROP COLUMN IF EXISTS background`.execute(db);
}
