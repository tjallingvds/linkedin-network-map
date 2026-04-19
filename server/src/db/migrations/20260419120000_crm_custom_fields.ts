import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * Adds a jsonb `custom_fields` bag to crm_contacts so users can define their
 * own columns per board (name, type stored client-side; values live here).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("crm_contacts")
    .addColumn("custom_fields", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("crm_contacts").dropColumn("custom_fields").execute();
}
