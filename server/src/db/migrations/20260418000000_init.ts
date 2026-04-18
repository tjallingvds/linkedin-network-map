import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`.execute(db);

  // ---------- users ----------
  await db.schema
    .createTable("users")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("email", "text", (c) => c.notNull().unique())
    .addColumn("email_verified", "timestamptz")
    .addColumn("name", "text")
    .addColumn("image", "text")
    .addColumn("password_hash", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // ---------- accounts (OAuth links, Auth.js shape) ----------
  await db.schema
    .createTable("accounts")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("type", "text", (c) => c.notNull())
    .addColumn("provider", "text", (c) => c.notNull())
    .addColumn("provider_account_id", "text", (c) => c.notNull())
    .addColumn("access_token", "text")
    .addColumn("refresh_token", "text")
    .addColumn("expires_at", "bigint")
    .addColumn("token_type", "text")
    .addColumn("scope", "text")
    .addColumn("id_token", "text")
    .addColumn("session_state", "text")
    .addUniqueConstraint("accounts_provider_unique", ["provider", "provider_account_id"])
    .execute();

  // ---------- sessions (Auth.js DB sessions) ----------
  await db.schema
    .createTable("sessions")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("session_token", "text", (c) => c.notNull().unique())
    .addColumn("expires", "timestamptz", (c) => c.notNull())
    .execute();

  // ---------- verification_tokens (email magic links) ----------
  await db.schema
    .createTable("verification_tokens")
    .addColumn("identifier", "text", (c) => c.notNull())
    .addColumn("token", "text", (c) => c.notNull().unique())
    .addColumn("expires", "timestamptz", (c) => c.notNull())
    .addPrimaryKeyConstraint("verification_tokens_pk", ["identifier", "token"])
    .execute();

  // ---------- people (connections) ----------
  await db.schema
    .createTable("people")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("first_name", "text", (c) => c.notNull())
    .addColumn("last_name", "text", (c) => c.notNull())
    .addColumn("company", "text")
    .addColumn("position", "text")
    .addColumn("linkedin_url", "text")
    .addColumn("email", "text")
    .addColumn("phone", "text")
    .addColumn("connected_on", "text")
    .addColumn("category", "text")
    .addColumn("industry", "text")
    .addColumn("enrichment", "jsonb")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex("people_user_id_idx").on("people").column("user_id").execute();
  await db.schema
    .createIndex("people_user_name_idx")
    .on("people")
    .columns(["user_id", "last_name", "first_name"])
    .execute();

  // ---------- chats + messages ----------
  await db.schema
    .createTable("chats")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("title", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex("chats_user_id_idx").on("chats").column("user_id").execute();

  await db.schema
    .createTable("messages")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("chat_id", "uuid", (c) => c.notNull().references("chats.id").onDelete("cascade"))
    .addColumn("role", "text", (c) => c.notNull())
    .addColumn("content", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex("messages_chat_id_idx").on("messages").column("chat_id").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("messages").ifExists().execute();
  await db.schema.dropTable("chats").ifExists().execute();
  await db.schema.dropTable("people").ifExists().execute();
  await db.schema.dropTable("verification_tokens").ifExists().execute();
  await db.schema.dropTable("sessions").ifExists().execute();
  await db.schema.dropTable("accounts").ifExists().execute();
  await db.schema.dropTable("users").ifExists().execute();
}
