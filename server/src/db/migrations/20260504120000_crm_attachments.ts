import { sql, type Kysely } from "kysely";

/**
 * Per-contact file attachments (PDFs and similar). Stored as BYTEA in
 * Postgres so we don't need an external object store — a CRM with
 * dozens of small briefs / proposals is well within what the DB can
 * carry. Cell value is the attachment id; the bytes stream out via a
 * dedicated download route.
 *
 * Idempotent — uses CREATE TABLE IF NOT EXISTS.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // crm_contacts.id is UUID (the existing schema) — the FK column has to
  // match. The attachment id stays TEXT because the client mints it as
  // a short slug ("att_xyz") so callers can reference it locally before
  // the upload round-trips.
  await sql`
    CREATE TABLE IF NOT EXISTS crm_attachments (
      id TEXT PRIMARY KEY,
      contact_id UUID NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS crm_attachments_contact_id_idx ON crm_attachments(contact_id)`.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS crm_attachments`.execute(db);
}
