import { sql, type Kysely } from "kysely";

/**
 * Message branching. Adds a nullable `parent_id` so a chat becomes a tree
 * instead of a flat append-only log: editing a message forks a sibling
 * branch, retrying an answer adds a sibling assistant message, and the
 * visible conversation is the active root→leaf path. Existing chats are
 * backfilled into a single linear chain (each row's parent = the previous
 * row by created_at) so they render unchanged as one branch.
 *
 * All statements are idempotent (IF [NOT] EXISTS): migrations run on
 * container boot, and an earlier broken version of this migration could have
 * left a partially-applied state, so a clean retry must not error.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES messages(id) ON DELETE CASCADE`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS messages_parent_id_idx ON messages(parent_id)`.execute(db);

  // Backfill: within each chat, link rows in created_at order so the first
  // message keeps parent_id = null and every later one points at its
  // predecessor. A LAG() window function in a CTE computes each row's
  // predecessor; a standard UPDATE…FROM join writes it. (The earlier version
  // used `UPDATE … FROM LATERAL (…)` referencing the UPDATE target table,
  // which Postgres rejects.)
  await sql`
    WITH ordered AS (
      SELECT id, LAG(id) OVER (PARTITION BY chat_id ORDER BY created_at, id) AS prev_id
      FROM messages
    )
    UPDATE messages m
    SET parent_id = o.prev_id
    FROM ordered o
    WHERE o.id = m.id
      AND o.prev_id IS NOT NULL
      AND m.parent_id IS NULL
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS messages_parent_id_idx`.execute(db);
  await sql`ALTER TABLE messages DROP COLUMN IF EXISTS parent_id`.execute(db);
}
