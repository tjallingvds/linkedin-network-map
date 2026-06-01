import { sql, type Kysely } from "kysely";

/**
 * Message branching. Adds a nullable `parent_id` so a chat becomes a tree
 * instead of a flat append-only log: editing a message forks a sibling
 * branch, retrying an answer adds a sibling assistant message, and the
 * visible conversation is the active root→leaf path. Existing chats are
 * backfilled into a single linear chain (each row's parent = the previous
 * row by created_at) so they render unchanged as one branch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("messages")
    .addColumn("parent_id", "uuid", (c) => c.references("messages.id").onDelete("cascade"))
    .execute();

  await db.schema
    .createIndex("messages_parent_id_idx")
    .on("messages")
    .column("parent_id")
    .execute();

  // Backfill: within each chat, link rows in created_at order so the first
  // message has parent_id = null and every later one points at its
  // predecessor. A correlated subquery picks the immediately-earlier row in
  // the same chat (ties broken by id so it's deterministic).
  await sql`
    UPDATE messages m
    SET parent_id = prev.id
    FROM LATERAL (
      SELECT p.id
      FROM messages p
      WHERE p.chat_id = m.chat_id
        AND (p.created_at, p.id) < (m.created_at, m.id)
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 1
    ) AS prev
    WHERE m.parent_id IS NULL
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("messages_parent_id_idx").execute();
  await db.schema.alterTable("messages").dropColumn("parent_id").execute();
}
