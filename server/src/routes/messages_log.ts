/**
 * message_log routes — bulk-insert parsed LinkedIn messages.csv rows,
 * report stats, and let the user wipe the log.
 *
 *   GET    /api/messages-log/stats   counts + last-imported timestamp
 *   POST   /api/messages-log/bulk    bulk insert
 *   DELETE /api/messages-log         wipe the user's whole log
 *
 * Only the user_id-scoped subset of rows is ever read or written.
 */
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { sql } from "kysely";
import type { AuthedRequest } from "../auth/session.js";
import {
  normalizeCounterpartName,
  normalizeCounterpartLinkedIn,
} from "../ai/messaged-set.js";

const router = Router();

const messageInput = z.object({
  conversationId: z.string().nullish(),
  counterpartName: z.string().min(1).max(200),
  counterpartLinkedinUrl: z.string().max(500).nullish(),
  /** Treated as a free-form string — must be one of "sent" / "received". */
  direction: z.enum(["sent", "received"]),
  messageDate: z.string().max(64).nullish(),
  subject: z.string().max(500).nullish(),
  contentSnippet: z.string().max(2000).nullish(),
});

router.get("/stats", async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const totals = await db
    .selectFrom("message_log")
    .select((eb) => [
      eb.fn.count<number>("id").as("total"),
      eb.fn.count<number>("id").filterWhere("direction", "=", "sent").as("sent"),
      eb.fn.count<number>("id").filterWhere("direction", "=", "received").as("received"),
      sql<number>`count(distinct counterpart_name_normalized)`.as("uniqueCounterparts"),
      sql<string | null>`max(created_at)::text`.as("lastImportedAt"),
    ])
    .where("user_id", "=", userId)
    .executeTakeFirst();

  res.json({
    total: Number(totals?.total ?? 0),
    sent: Number(totals?.sent ?? 0),
    received: Number(totals?.received ?? 0),
    uniqueCounterparts: Number(totals?.uniqueCounterparts ?? 0),
    lastImportedAt: totals?.lastImportedAt ?? null,
  });
});

router.post("/bulk", async (req: AuthedRequest, res) => {
  const parsed = z.object({
    messages: z.array(messageInput).max(50_000),
    /** When true, replace the user's existing log before inserting. Used by
     *  the import flow so re-uploading a fresh export doesn't double-count. */
    replace: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });

  const userId = req.user!.id;

  if (parsed.data.replace) {
    await db.deleteFrom("message_log").where("user_id", "=", userId).execute();
  }

  if (parsed.data.messages.length === 0) {
    return res.json({ inserted: 0, total: 0 });
  }

  // Insert in batches of 500 to keep parameter count under Postgres' limit
  // (each row is ~9 cols × 500 = 4500 params, well under 65535).
  let inserted = 0;
  for (let i = 0; i < parsed.data.messages.length; i += 500) {
    const batch = parsed.data.messages.slice(i, i + 500);
    const r = await db
      .insertInto("message_log")
      .values(
        batch.map((m) => ({
          user_id: userId,
          conversation_id: m.conversationId ?? null,
          counterpart_name: m.counterpartName,
          counterpart_name_normalized: normalizeCounterpartName(m.counterpartName),
          counterpart_linkedin_url: m.counterpartLinkedinUrl ?? null,
          counterpart_linkedin_normalized: m.counterpartLinkedinUrl
            ? normalizeCounterpartLinkedIn(m.counterpartLinkedinUrl)
            : null,
          direction: m.direction,
          message_date: m.messageDate ?? null,
          subject: m.subject ?? null,
          content_snippet: m.contentSnippet ?? null,
        })),
      )
      .execute();
    inserted += Number(r[0]?.numInsertedOrUpdatedRows ?? batch.length);
  }

  const total = await db
    .selectFrom("message_log")
    .select((eb) => eb.fn.count<number>("id").as("c"))
    .where("user_id", "=", userId)
    .executeTakeFirst();

  res.json({ inserted, total: Number(total?.c ?? 0) });
});

router.delete("/", async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  await db.deleteFrom("message_log").where("user_id", "=", userId).execute();
  res.json({ ok: true });
});

export default router;
