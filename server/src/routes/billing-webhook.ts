/**
 * Stripe webhook — grants credits on successful checkout. Mounted with
 * express.raw() in server/src/index.ts BEFORE express.json() so the
 * signature can be verified.
 *
 * Idempotency: each event is recorded in `credit_purchases.stripe_event_id`
 * (unique); duplicate deliveries become a no-op.
 */
import type { Request, Response } from "express";
import Stripe from "stripe";
import { env } from "../env.js";
import { db } from "../db/index.js";

const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;

export async function stripeWebhookHandler(req: Request, res: Response) {
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
    return res.status(501).json({ error: "webhook_not_configured" });
  }
  const sig = req.headers["stripe-signature"];
  if (!sig) return res.status(400).send("missing signature");

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`webhook error: ${(err as Error).message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    await grantCredits(event.id, session);
  }

  res.json({ received: true });
}

async function grantCredits(eventId: string, session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId ?? session.client_reference_id;
  const packId = session.metadata?.packId;
  const credits = Number(session.metadata?.creditsGranted ?? 0);
  if (!userId || !packId || !credits) {
    console.warn("checkout.session.completed missing metadata", session.id);
    return;
  }

  // Idempotency: unique on stripe_event_id. If this event was already
  // processed, the insert throws and we skip the balance update.
  try {
    await db
      .insertInto("credit_purchases")
      .values({
        user_id: userId,
        stripe_event_id: eventId,
        stripe_session_id: session.id,
        pack_id: packId,
        credits_granted: credits,
        amount_cents: session.amount_total ?? 0,
        currency: (session.currency ?? "usd").toLowerCase(),
      })
      .execute();
  } catch (err) {
    // Most common cause: duplicate event. Log and stop — balance already updated.
    console.warn("credit_purchases insert failed (likely duplicate):", (err as Error).message);
    return;
  }

  await db
    .updateTable("users")
    .set((eb) => ({ credit_balance: eb("credit_balance", "+", credits) }))
    .where("id", "=", userId)
    .execute();

  console.log(`granted ${credits} credits to user ${userId} (pack=${packId}, session=${session.id})`);
}
