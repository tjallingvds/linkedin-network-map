import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("usage_events")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    // 'openai' | 'anthropic' | 'deepseek' | 'tavily' | 'apollo'
    .addColumn("provider", "text", (c) => c.notNull())
    // 'chat' | 'json' | 'search' | 'match' | 'people_search'
    .addColumn("kind", "text", (c) => c.notNull())
    // Input + output tokens for LLM calls; 0 for non-LLM.
    .addColumn("input_tokens", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("output_tokens", "integer", (c) => c.notNull().defaultTo(0))
    // 1 per external call; Apollo/Tavily use this as "credits".
    .addColumn("credits", "integer", (c) => c.notNull().defaultTo(1))
    // Cost in micro-USD (1/1,000,000 USD) — stored as integer to avoid float drift.
    .addColumn("cost_micros", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("metadata", "jsonb")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("usage_events_user_created_idx")
    .on("usage_events")
    .columns(["user_id", "created_at"])
    .execute();

  await db.schema
    .createIndex("usage_events_user_provider_idx")
    .on("usage_events")
    .columns(["user_id", "provider"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("usage_events").ifExists().execute();
}
