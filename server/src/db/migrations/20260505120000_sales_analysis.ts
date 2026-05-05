/**
 * sales_analysis — multi-team-member CSV uploads and pinned custom analyses.
 *
 * One sales_analysis_uploads row per (user, team_member, snapshot). Connections and
 * messages are stored in dedicated tables so a single workspace user can hold
 * data for many sales reps without polluting their own people / message_log.
 *
 * sales_analysis_pinned is a list of custom analytics specs the user has
 * generated via the chat or built manually, so they reappear after reload.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("sales_analysis_uploads")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("team_member_name", "text", (c) => c.notNull())
    .addColumn("detected_user_name", "text")
    .addColumn("connections_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("messages_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("sales_analysis_uploads_user_idx")
    .on("sales_analysis_uploads")
    .column("user_id")
    .execute();

  await db.schema
    .createTable("sales_analysis_connections")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("upload_id", "uuid", (c) => c.notNull().references("sales_analysis_uploads.id").onDelete("cascade"))
    .addColumn("first_name", "text", (c) => c.notNull())
    .addColumn("last_name", "text", (c) => c.notNull())
    .addColumn("name_normalized", "text", (c) => c.notNull())
    .addColumn("company", "text")
    .addColumn("position", "text")
    .addColumn("seniority", "text")
    .addColumn("linkedin_url", "text")
    .addColumn("linkedin_normalized", "text")
    .addColumn("email", "text")
    .addColumn("connected_on", "text")
    .execute();

  await db.schema
    .createIndex("sales_analysis_connections_upload_idx")
    .on("sales_analysis_connections")
    .column("upload_id")
    .execute();

  await db.schema
    .createIndex("sales_analysis_connections_user_idx")
    .on("sales_analysis_connections")
    .column("user_id")
    .execute();

  await db.schema
    .createIndex("sales_analysis_connections_match_idx")
    .on("sales_analysis_connections")
    .columns(["upload_id", "name_normalized"])
    .execute();

  await db.schema
    .createTable("sales_analysis_messages")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("upload_id", "uuid", (c) => c.notNull().references("sales_analysis_uploads.id").onDelete("cascade"))
    .addColumn("conversation_id", "text")
    .addColumn("counterpart_name", "text", (c) => c.notNull())
    .addColumn("counterpart_name_normalized", "text", (c) => c.notNull())
    .addColumn("counterpart_linkedin_url", "text")
    .addColumn("counterpart_linkedin_normalized", "text")
    .addColumn("direction", "text", (c) => c.notNull())
    .addColumn("message_date", "text")
    .addColumn("message_ts", "timestamptz")
    .addColumn("subject", "text")
    .addColumn("content_snippet", "text")
    /** "cold" | "follow_up" | "reply" — computed from conversation order. */
    .addColumn("message_type", "text")
    .execute();

  await db.schema
    .createIndex("sales_analysis_messages_upload_idx")
    .on("sales_analysis_messages")
    .column("upload_id")
    .execute();

  await db.schema
    .createIndex("sales_analysis_messages_user_idx")
    .on("sales_analysis_messages")
    .column("user_id")
    .execute();

  await db.schema
    .createIndex("sales_analysis_messages_match_idx")
    .on("sales_analysis_messages")
    .columns(["upload_id", "counterpart_name_normalized"])
    .execute();

  await db.schema
    .createTable("sales_analysis_pinned")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("title", "text", (c) => c.notNull())
    .addColumn("question", "text")
    /** Spec is { kind: "bar"|"pie"|"line"|"number", series: [...], summary: "..." }. */
    .addColumn("spec", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("position", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("sales_analysis_pinned_user_idx")
    .on("sales_analysis_pinned")
    .column("user_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("sales_analysis_pinned").ifExists().execute();
  await db.schema.dropTable("sales_analysis_messages").ifExists().execute();
  await db.schema.dropTable("sales_analysis_connections").ifExists().execute();
  await db.schema.dropTable("sales_analysis_uploads").ifExists().execute();
}
