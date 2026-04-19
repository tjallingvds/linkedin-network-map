import type { Kysely } from "kysely";

/**
 * Persist the full structured CompletionResult on each assistant message so
 * prospect cards survive chat reload (before, only a plain-text summary was
 * kept and prospects silently disappeared when you reopened a past search).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("messages")
    .addColumn("result", "jsonb")
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("messages").dropColumn("result").execute();
}
