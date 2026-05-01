/**
 * message_log — one row per LinkedIn message, parsed from the user's
 * messages.csv export. Used by Network mode to know who the user has
 * already reached out to so chat queries like "haven't messaged yet"
 * can filter them out.
 *
 * The "counterpart" is the OTHER party in the conversation (recipient
 * for a sent message, sender for a received one). We store both their
 * display name and LinkedIn URL so matching against the people table
 * (which uses both fields) can fall back gracefully.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("message_log")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("conversation_id", "text")
    .addColumn("counterpart_name", "text", (c) => c.notNull())
    .addColumn("counterpart_name_normalized", "text", (c) => c.notNull())
    .addColumn("counterpart_linkedin_url", "text")
    .addColumn("counterpart_linkedin_normalized", "text")
    /** "sent" or "received". */
    .addColumn("direction", "text", (c) => c.notNull())
    /** Raw date string from the CSV (LinkedIn uses "YYYY-MM-DD HH:MM:SS UTC"). */
    .addColumn("message_date", "text")
    .addColumn("subject", "text")
    /** First ~200 chars of the message body — kept for context, not search. */
    .addColumn("content_snippet", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("message_log_user_idx")
    .on("message_log")
    .column("user_id")
    .execute();

  await db.schema
    .createIndex("message_log_user_name_idx")
    .on("message_log")
    .columns(["user_id", "counterpart_name_normalized"])
    .execute();

  await db.schema
    .createIndex("message_log_user_url_idx")
    .on("message_log")
    .columns(["user_id", "counterpart_linkedin_normalized"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("message_log").ifExists().execute();
}
