import { sql, type Kysely } from "kysely";

/**
 * Per-contact "last message" tracking — the timestamp of the most recent
 * touch and which direction it was (we sent it vs. we received it).
 *
 * Powers follow-up discipline: stale = outbound + no inbound + > N days.
 * Manual logging only (a "Sent" / "Received" button on the row stamps
 * now + direction); no auto-sync yet.
 *
 * The existing `last_touch` text column predates this and only ever held
 * human-readable strings ("2h ago"). It's left in place untouched to
 * avoid breaking older clients; new code reads/writes the two columns
 * below.
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS last_touch_at timestamptz`.execute(db);
  await sql`ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS last_touch_direction text`.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE crm_contacts DROP COLUMN IF EXISTS last_touch_direction`.execute(db);
  await sql`ALTER TABLE crm_contacts DROP COLUMN IF EXISTS last_touch_at`.execute(db);
}
