import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Credit balance on users. Signup grants NONE — users must buy a pack (or
  // we grant a free trial via webhook / a separate seed migration later).
  await db.schema
    .alterTable("users")
    .addColumn("credit_balance", "integer", (c) => c.notNull().defaultTo(0))
    .execute();

  // Audit log of every Stripe credit purchase. Also the idempotency mechanism
  // — duplicate webhook events (same stripe_event_id) are ignored.
  await db.schema
    .createTable("credit_purchases")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("stripe_event_id", "text", (c) => c.notNull().unique())
    .addColumn("stripe_session_id", "text")
    .addColumn("pack_id", "text", (c) => c.notNull())
    .addColumn("credits_granted", "integer", (c) => c.notNull())
    .addColumn("amount_cents", "integer", (c) => c.notNull())
    .addColumn("currency", "text", (c) => c.notNull().defaultTo("usd"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("credit_purchases_user_idx")
    .on("credit_purchases")
    .column("user_id")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("credit_purchases").ifExists().execute();
  await db.schema.alterTable("users").dropColumn("credit_balance").execute();
}
