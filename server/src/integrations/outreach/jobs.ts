/**
 * Durable background jobs for outreach (see the 20260723 migration).
 *
 * Exports can run for minutes — batches of 400 plus a lead-id sweep — which is
 * far past the platform's request cap. Same pattern the chat completions use:
 * start it, hand back an id, poll. Job rows also record reconcile runs so the
 * scheduler can survive process restarts.
 */
import { db } from "../../db/index.js";

export type JobKind = "export" | "reconcile";

/**
 * Record a human-initiated action in the same append-only log as provider
 * events, so "why did this lead stop?" has one answer instead of two. Manual
 * rows carry no request_id (nothing to dedupe against).
 */
export async function recordManualEvent(
  userId: string,
  eventType: "MANUAL_PAUSE" | "MANUAL_RESUME" | "MANUAL_SUPPRESS" | "MANUAL_DOMAIN_BLOCK",
  detail: { contactId?: string; email?: string; actorId?: string; note?: string },
): Promise<void> {
  try {
    await db.insertInto("outreach_events").values({
      user_id: userId,
      request_id: null,
      event_type: eventType,
      provider_campaign_id: null,
      provider_lead_id: null,
      to_email: detail.email ?? null,
      contact_id: detail.contactId ?? null,
      payload: JSON.stringify({ actorId: detail.actorId, note: detail.note }) as never,
    }).execute();
  } catch (err) {
    console.error("[outreach] audit write failed:", (err as Error).message);
  }
}

export async function createJob(userId: string | null, kind: JobKind): Promise<string> {
  const row = await db
    .insertInto("outreach_jobs")
    .values({ user_id: userId, kind, status: "running" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function setProgress(id: string, progress: string): Promise<void> {
  await db.updateTable("outreach_jobs")
    .set({ progress, updated_at: new Date() as never })
    .where("id", "=", id).execute();
}

export async function finishJob(id: string, result: unknown): Promise<void> {
  await db.updateTable("outreach_jobs")
    .set({ status: "done", result: JSON.stringify(result) as never, updated_at: new Date() as never })
    .where("id", "=", id).execute();
}

export async function failJob(id: string, error: string): Promise<void> {
  await db.updateTable("outreach_jobs")
    .set({ status: "error", error, updated_at: new Date() as never })
    .where("id", "=", id).execute();
}

export async function getJob(id: string, userId: string) {
  return db
    .selectFrom("outreach_jobs")
    .select(["id", "kind", "status", "progress", "result", "error", "created_at", "updated_at"])
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .executeTakeFirst();
}

/** When did a job of this kind last start? Drives the scheduler across
 *  restarts — a naive setInterval resets on every deploy and may never fire. */
export async function lastRunAt(kind: JobKind): Promise<Date | null> {
  const row = await db
    .selectFrom("outreach_jobs")
    .select("created_at")
    .where("kind", "=", kind)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row ? new Date(row.created_at as unknown as string) : null;
}
