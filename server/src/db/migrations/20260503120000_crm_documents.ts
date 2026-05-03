import { sql, type Kysely } from "kysely";

/**
 * Notion-style long-form pages attached to each CRM contact. Stored as
 * JSONB so we can evolve the document shape (rich-text blocks, etc.)
 * without further schema churn.
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS so re-running won't crash.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS documents JSONB`.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE crm_contacts DROP COLUMN IF EXISTS documents`.execute(db);
}
