import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * CRM board sharing.
 *
 * Each board can generate a share_token. Anyone holding that token can join
 * the board via POST /api/crm/share/:token/join, which inserts a row in
 * crm_board_members. From then on, GET /boards returns the board for both
 * the owner and every member, and every board/contacts endpoint authorises
 * on "owner OR member".
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("crm_boards")
    .addColumn("share_token", "text")
    .execute();

  await db.schema
    .createTable("crm_board_members")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("board_id", "uuid", (c) => c.notNull().references("crm_boards.id").onDelete("cascade"))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("crm_board_members_unique", ["board_id", "user_id"])
    .execute();

  await db.schema
    .createIndex("crm_board_members_user_idx")
    .on("crm_board_members")
    .column("user_id")
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("crm_board_members").execute();
  await db.schema.alterTable("crm_boards").dropColumn("share_token").execute();
}
