/**
 * Remember webhook deliveries we turned away.
 *
 * A delivery with a bad or missing signature is rejected and never recorded,
 * so "Smartlead is calling us but we reject every one" and "Smartlead has
 * never called us" looked identical on screen — while having completely
 * different fixes (paste the signing secret vs. save the URL at all).
 */
import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("smartlead_accounts")
    .addColumn("webhook_rejected_count", "integer", (c) => c.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable("smartlead_accounts")
    .addColumn("webhook_rejected_at", "timestamptz")
    .execute();
  await db.schema
    .alterTable("smartlead_accounts")
    /** 'unsigned' — no signature header at all, or 'mismatch' — wrong secret. */
    .addColumn("webhook_rejected_reason", "text")
    .execute();

  await db.schema
    .alterTable("smartlead_accounts")
    /** The `secret_key` Smartlead itself put in the first delivery we accepted.
     *  Smartlead generates this; there is no field to type ours into. Learning
     *  it on first contact lets every later delivery be checked against it. */
    .addColumn("observed_secret_key", "text")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("smartlead_accounts").dropColumn("webhook_rejected_count").execute();
  await db.schema.alterTable("smartlead_accounts").dropColumn("webhook_rejected_at").execute();
  await db.schema.alterTable("smartlead_accounts").dropColumn("webhook_rejected_reason").execute();
  await db.schema.alterTable("smartlead_accounts").dropColumn("observed_secret_key").execute();
}
