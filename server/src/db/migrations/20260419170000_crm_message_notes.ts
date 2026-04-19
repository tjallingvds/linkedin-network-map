import type { Kysely } from "kysely";

/**
 * Separate "what to personalize" field from general `notes` — users wanted
 * a distinct spot to jot the hook/angle to use when they message someone.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("crm_contacts")
    .addColumn("message_notes", "text")
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("crm_contacts").dropColumn("message_notes").execute();
}
