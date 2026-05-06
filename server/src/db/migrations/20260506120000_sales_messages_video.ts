/**
 * Adds has_video to sales_analysis_messages so we can count messages that
 * carried a video attachment (LinkedIn's native video upload, Loom, Vidyard,
 * Vimeo, Wistia, YouTube). Video presence used to be inferred from a regex
 * over the content snippet, which missed every LinkedIn-native video because
 * those don't add text to the message body — they live in the ATTACHMENTS
 * column of the CSV, which the importer wasn't reading.
 *
 * The column is nullable + defaults to false so existing rows keep working;
 * the user re-uploads to get accurate counts. The audit endpoint OR's the
 * DB flag with the snippet regex so older imports still get rough detection.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sales_analysis_messages")
    .addColumn("has_video", "boolean", (c) => c.notNull().defaultTo(sql`false`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sales_analysis_messages")
    .dropColumn("has_video")
    .execute();
}
