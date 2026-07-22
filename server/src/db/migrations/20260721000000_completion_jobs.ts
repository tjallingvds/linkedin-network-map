import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * Durable completion jobs. The typed AI search runs in a background job so it
 * isn't bound by the platform's ~60-90s HTTP request cap; the client polls for
 * the result. That job state used to live in an in-process Map, so a process
 * restart (Railway redeploy / OOM / autoscale) dropped every in-flight and
 * recently-finished job — the client's poll then 404'd and a completed search
 * looked lost.
 *
 * Persisting job state here fixes that: a finished result survives a restart
 * (the poll still resolves), and a job whose process died mid-run is detected
 * as a stale 'running' row and surfaced to the user as a clean "re-run" prompt
 * instead of an infinite spinner. (The heavy work still runs in the web
 * process and closes over the user's BYOK API keys, which are deliberately
 * never persisted — so an interrupted run can't be auto-resumed, only reported.)
 *
 * Idempotent (IF NOT EXISTS) because migrations run on container boot.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("completion_jobs")
    .ifNotExists()
    // Caller-supplied id (the client references the job before the row exists
    // in its own state), so no default — the route always provides it.
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("chat_id", "uuid", (c) => c.references("chats.id").onDelete("cascade"))
    // 'running' | 'done' | 'error'
    .addColumn("status", "text", (c) => c.notNull().defaultTo("running"))
    .addColumn("progress", "text")
    // Full CompletionPayload JSON once done. Null while running / on error.
    .addColumn("result", "jsonb")
    .addColumn("error", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  // Drives the age-based reap + stale-running detection.
  await db.schema
    .createIndex("completion_jobs_created_idx")
    .ifNotExists()
    .on("completion_jobs")
    .column("created_at")
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("completion_jobs").ifExists().execute();
}
