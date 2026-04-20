import type { Kysely } from "kysely";

/**
 * Store AI-generated background info per contact (recent posts, talks,
 * funny things they've said publicly — with source URLs). Separate from
 * `notes` and `message_notes` so the background auto-enrichment doesn't
 * clobber the user's own hand-typed context.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("crm_contacts")
    .addColumn("background", "text")
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("crm_contacts").dropColumn("background").execute();
}
