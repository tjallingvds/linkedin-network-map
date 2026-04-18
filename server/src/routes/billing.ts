/**
 * Billing routes:
 *   GET  /api/billing/packs      — catalog + user's current credit balance
 *   POST /api/billing/checkout   — create Stripe Checkout session for one pack
 *   GET  /api/billing/status     — whether Stripe is configured
 *
 * Webhook lives in routes/billing-webhook.ts and must mount before
 * express.json() (see server/src/index.ts).
 */
import { Router } from "express";
import { z } from "zod";
import Stripe from "stripe";
import { env } from "../env.js";
import type { AuthedRequest } from "../auth/session.js";
import { getPack, listPacks } from "../billing/packs.js";
import { getCreditBalance } from "../usage/tracker.js";

const router = Router();

const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;

router.get("/packs", async (req: AuthedRequest, res) => {
  const balance = await getCreditBalance(req.user!.id);
  res.json({
    balance,
    packs: listPacks().map((p) => ({
      id: p.id,
      name: p.name,
      credits: p.credits,
      amountCents: p.amountCents,
      priceLabel: p.priceLabel,
      bonus: p.bonus,
      popular: p.popular,
      // Don't expose Stripe price IDs to the client.
    })),
    currency: "usd",
    configured: !!stripe,
  });
});

router.post("/checkout", async (req: AuthedRequest, res) => {
  const parsed = z.object({ packId: z.enum(["starter", "growth", "scale"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  const pack = getPack(parsed.data.packId);
  if (!pack) return res.status(404).json({ error: "pack_not_found" });
  if (!stripe) return res.status(501).json({ error: "billing_not_configured" });

  // Prefer a pre-configured Stripe price; otherwise create an inline price_data.
  const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = pack.priceId
    ? { price: pack.priceId, quantity: 1 }
    : {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: pack.amountCents,
          product_data: {
            name: `Nontrivial — ${pack.name} credit pack`,
            description: `${pack.credits.toLocaleString()} credits${pack.bonus ? ` (${pack.bonus})` : ""}`,
          },
        },
      };

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [lineItem],
    customer_email: req.user!.email,
    client_reference_id: req.user!.id,
    metadata: {
      userId: req.user!.id,
      packId: pack.id,
      creditsGranted: String(pack.credits),
    },
    success_url: `${env.CLIENT_URL}/?credits=granted&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.CLIENT_URL}/?credits=cancelled`,
  });

  res.json({ url: session.url });
});

router.get("/status", async (req: AuthedRequest, res) => {
  const balance = await getCreditBalance(req.user!.id);
  res.json({ configured: !!stripe, balance });
});

export default router;
