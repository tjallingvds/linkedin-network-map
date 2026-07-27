/**
 * Durable background jobs for outreach.
 *
 * Two problems this solves:
 *  1. Export ran synchronously inside the HTTP request. A few thousand leads
 *     (batches + per-lead id resolution) blows past the platform's ~120-300s
 *     request cap and the socket dies mid-push. Same shape as completion_jobs:
 *     start it, return an id, poll.
 *  2. The nightly reconciler was a naive setInterval(24h) started at boot — a
 *     deploy resets the timer, so on a daily-deploy cadence it never fires.
 *     Recording each run here lets the scheduler ask "when did this last
 *     actually run?" and survive restarts.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("outreach_jobs")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    /** Null for global jobs (a reconcile sweep across all accounts). */
    .addColumn("user_id", "uuid", (c) => c.references("users.id").onDelete("cascade"))
    /** 'export' | 'reconcile'. */
    .addColumn("kind", "text", (c) => c.notNull())
    /** 'running' | 'done' | 'error'. */
    .addColumn("status", "text", (c) => c.notNull().defaultTo("running"))
    /** Human-readable progress line, e.g. "batch 2/7 — 800 pushed". */
    .addColumn("progress", "text")
    .addColumn("result", "jsonb")
    .addColumn("error", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("outreach_jobs_user_kind_idx")
    .on("outreach_jobs")
    .columns(["user_id", "kind", "created_at"])
    .execute();

  // Scheduler lookup: "most recent reconcile run, any user".
  await db.schema
    .createIndex("outreach_jobs_kind_created_idx")
    .on("outreach_jobs")
    .columns(["kind", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("outreach_jobs").ifExists().execute();
}
