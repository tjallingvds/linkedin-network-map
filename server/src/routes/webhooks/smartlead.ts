/**
 * Inbound Smartlead webhooks. PUBLIC route (no session).
 *
 * Mounted in index.ts BEFORE the global express.json() parser, with
 * express.raw() so an HMAC can still be computed over the exact bytes.
 *
 * HOW A DELIVERY IS AUTHENTICATED
 *
 * Smartlead does not sign its webhooks. There is no signature header, and its
 * webhook form has no field to type a shared secret into — it puts its own
 * generated `secret_key` in the JSON body instead. This route used to require
 * an `X-Smartlead-Signature` HMAC, so every real delivery was rejected with a
 * 401 and the whole feature sat silent: nobody marked contacted, no cards
 * moved, no replies stopping the follow-ups.
 *
 * So the URL is the credential. The token in the path is 24 random bytes,
 * unguessable, unique per board and rotatable — the usual arrangement when the
 * sender cannot sign. That URL should be treated like a password: anyone
 * holding it can post events for that board.
 *
 * Two optional checks tighten this where they can:
 *   - a signature header, if one is ever present, must verify;
 *   - `secret_key` is learned from the first delivery, and every later one
 *     must match it, so a leaked URL alone stops being enough after that.
 *
 * Rejections are recorded on the account, because "rejected" and "never
 * arrived" look identical on screen and have completely different fixes.
 */
import { Router, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import { db } from "../../db/index.js";
import { getAccountByWebhookToken } from "../../integrations/outreach/accounts.js";
import {
  processEvent, eventTypeOf, eventIdOf, type SmartleadWebhookPayload,
} from "../../integrations/outreach/events.js";
import { alertUser } from "../../integrations/outreach/alerts.js";

const router = Router();

/** Constant-time compare that tolerates different lengths. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

function verifySignature(raw: Buffer, signature: string, secret: string): boolean {
  return sameSecret(createHmac("sha256", secret).update(raw).digest("hex"), signature);
}

async function recordRejection(accountId: string, userId: string, reason: string, message: string) {
  await db
    .updateTable("smartlead_accounts")
    .set({
      webhook_rejected_count: sql`coalesce(webhook_rejected_count, 0) + 1`,
      webhook_rejected_at: new Date(),
      webhook_rejected_reason: reason,
    })
    .where("id", "=", accountId)
    .execute()
    .catch(() => { /* diagnostics must never fail the response */ });
  await alertUser(userId, message, { kind: "webhook_rejected", severity: "critical" })
    .catch(() => { /* nor must alerting */ });
}

router.post("/:token", async (req: Request, res: Response) => {
  const account = await getAccountByWebhookToken(req.params.token);
  if (!account) return res.status(401).end();

  // express.raw leaves a Buffer on req.body; fall back defensively.
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : "");

  let payload: SmartleadWebhookPayload;
  try {
    payload = JSON.parse(raw.toString("utf8")) as SmartleadWebhookPayload;
  } catch {
    // Malformed JSON is not transient — ack so Smartlead stops retrying.
    return res.status(200).end();
  }

  // A signature is optional, but a present one must be right.
  const sig = req.header("x-smartlead-signature");
  if (sig && !verifySignature(raw, sig, account.webhookSecret)) {
    await recordRejection(account.id, account.userId, "mismatch",
      "A webhook delivery arrived with a signature that doesn't match. Make a new webhook URL and update Smartlead.");
    return res.status(401).end();
  }

  // `secret_key` is Smartlead's own value. Learn it once, then require it.
  const offered = typeof payload.secret_key === "string" ? payload.secret_key.trim() : "";
  const known = account.observedSecretKey;
  if (known && offered && !sameSecret(known, offered)) {
    await recordRejection(account.id, account.userId, "secret_key",
      "A webhook delivery arrived with the wrong secret_key. If you recreated the webhook in Smartlead, make a new URL here.");
    return res.status(401).end();
  }
  if (!known && offered) {
    await db.updateTable("smartlead_accounts")
      .set({ observed_secret_key: offered })
      .where("id", "=", account.id).execute()
      .catch(() => { /* first-contact learning is best-effort */ });
  }

  // Idempotency: Smartlead's own event id when it sends one, the request id
  // otherwise. The unique index makes a duplicate insert throw.
  const requestId = eventIdOf(payload) ?? req.header("x-request-id") ?? null;
  const eventType = eventTypeOf(payload);

  try {
    await db
      .insertInto("outreach_events")
      .values({
        user_id: account.userId,
        request_id: requestId,
        event_type: eventType,
        provider_campaign_id: payload.campaign_id != null ? String(payload.campaign_id) : null,
        provider_lead_id:
          payload.sl_email_lead_id != null ? String(payload.sl_email_lead_id)
            : payload.lead_id != null ? String(payload.lead_id) : null,
        to_email: (payload.sl_lead_email ?? payload.to_email ?? payload.email ?? null) as string | null,
        contact_id: null,
        payload: JSON.stringify(payload),
      })
      .execute();
  } catch (err) {
    // Unique violation on request_id → duplicate delivery. Any other DB error
    // we still ack (the reconciler is the backstop) but log.
    const code = (err as { code?: string }).code;
    if (code === "23505") return res.status(200).end();
    console.error("[webhook] event insert failed:", (err as Error).message);
  }

  if (!requestId) console.warn("[webhook] event with no stats_id or request id — cannot dedupe:", eventType);

  // Ack now, process after. A processing error must never turn into a 4xx/5xx.
  res.status(200).end();
  setImmediate(() => {
    processEvent(account, payload)
      .then((label) => console.log(`[webhook] ${eventType} -> ${label}`))
      .catch((err) => console.error(`[webhook] processing ${eventType} failed:`, (err as Error).message));
  });
});

export default router;
