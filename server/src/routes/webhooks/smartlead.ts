/**
 * Inbound Smartlead webhooks.  PUBLIC route (no session) — authenticated by a
 * per-account token in the URL plus an HMAC signature over the raw body.
 *
 * Mounted in index.ts BEFORE the global express.json() parser, with
 * express.raw() so we get the exact bytes Smartlead signed. Never mount this
 * under requireAuth.
 *
 * Contract (spec §3):
 *   - Verify X-Smartlead-Signature = HMAC-SHA256(raw body, webhook_secret),
 *     constant-time. 401 on mismatch.
 *   - Dedupe on X-Request-Id via the unique index on outreach_events.
 *   - Return 2xx immediately, then process async. Never return 4xx for a
 *     transient problem — Smartlead treats 4xx as permanent and won't retry.
 */
import { Router, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "../../db/index.js";
import { getAccountByWebhookToken } from "../../integrations/outreach/accounts.js";
import { processEvent, eventTypeOf, type SmartleadWebhookPayload } from "../../integrations/outreach/events.js";

const router = Router();

function verifySignature(raw: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

router.post("/:token", async (req: Request, res: Response) => {
  const account = await getAccountByWebhookToken(req.params.token);
  if (!account) return res.status(401).end();

  // express.raw leaves a Buffer on req.body; fall back defensively.
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : "");
  const sig = req.header("x-smartlead-signature") ?? "";
  if (!sig || !verifySignature(raw, sig, account.webhookSecret)) return res.status(401).end();

  let payload: SmartleadWebhookPayload;
  try {
    payload = JSON.parse(raw.toString("utf8")) as SmartleadWebhookPayload;
  } catch {
    // Malformed JSON is not a transient problem — ack so Smartlead stops
    // retrying, but do nothing.
    return res.status(200).end();
  }

  const requestId = req.header("x-request-id") ?? null;
  const eventType = eventTypeOf(payload);

  // Idempotency: the unique index on request_id makes a duplicate insert throw.
  // Treat that as "already handled" and 200 without reprocessing.
  try {
    await db
      .insertInto("outreach_events")
      .values({
        user_id: account.userId,
        request_id: requestId,
        event_type: eventType,
        provider_campaign_id: payload.campaign_id != null ? String(payload.campaign_id) : null,
        provider_lead_id: payload.lead_id != null ? String(payload.lead_id) : null,
        to_email: (payload.to_email ?? payload.email ?? null) as string | null,
        contact_id: null,
        payload: JSON.stringify(payload),
      })
      .execute();
  } catch (err) {
    // Unique violation on request_id → duplicate delivery. Any other DB error
    // we still ack (reconciler is the backstop) but log.
    const code = (err as { code?: string }).code;
    if (code === "23505") return res.status(200).end();
    console.error("[webhook] event insert failed:", (err as Error).message);
  }

  if (!requestId) console.warn("[webhook] event without X-Request-Id — cannot dedupe:", eventType);

  // Ack now, process after. A processing error must never turn into a 4xx/5xx.
  res.status(200).end();
  setImmediate(() => {
    processEvent(account, payload)
      .then((label) => console.log(`[webhook] ${eventType} -> ${label}`))
      .catch((err) => console.error(`[webhook] processing ${eventType} failed:`, (err as Error).message));
  });
});

export default router;
