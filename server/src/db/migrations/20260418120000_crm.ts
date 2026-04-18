import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Multi-board CRM
  await db.schema
    .createTable("crm_boards")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("emoji", "text", (c) => c.notNull().defaultTo("📣"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("crm_boards_user_idx").on("crm_boards").column("user_id").execute();

  await db.schema
    .createTable("crm_contacts")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("board_id", "uuid", (c) => c.notNull().references("crm_boards.id").onDelete("cascade"))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("title", "text")
    .addColumn("company", "text")
    .addColumn("email", "text")
    .addColumn("phone", "text")
    .addColumn("linkedin", "text")
    .addColumn("stage", "text", (c) => c.notNull().defaultTo("new"))
    .addColumn("temp", "text", (c) => c.notNull().defaultTo("warm"))
    .addColumn("sent", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("opens", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("replies", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("last_touch", "text")
    .addColumn("next_step", "text")
    .addColumn("source", "text")
    .addColumn("notes", "text")
    .addColumn("position_idx", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("crm_contacts_board_idx").on("crm_contacts").column("board_id").execute();
  await db.schema.createIndex("crm_contacts_user_idx").on("crm_contacts").column("user_id").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("crm_contacts").ifExists().execute();
  await db.schema.dropTable("crm_boards").ifExists().execute();
}
