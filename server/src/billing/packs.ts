/**
 * Credit packs + per-action credit costs. Central source of truth — the
 * Stripe checkout route, the usage tracker, and the /api/billing/packs
 * endpoint all read from here.
 *
 * Pricing math (per $19 Starter pack, 1,000 credits):
 *   COGS         ≈ $4.00   (credits × blended wholesale rate)
 *   Stripe fee   ≈ $0.80   (~3% + €0.25 floor, rounded)
 *   VAT buffer   ≈ $3.80   (21% NL VAT absorbed, not added on top)
 *   → Net margin ≈ $10.40 (~55%)
 *
 * Larger packs get a bonus credit rate because our fixed Stripe floor becomes
 * relatively smaller and fewer checkout friction points per dollar collected.
 */
import { env } from "../env.js";

export interface CreditPack {
  id: "starter" | "growth" | "scale";
  name: string;
  credits: number;
  amountCents: number; // in cents
  priceLabel: string;  // "$19"
  bonus?: string;
  priceId?: string;    // Stripe price_id from env, if configured
  popular?: boolean;
}

export function listPacks(): CreditPack[] {
  return [
    {
      id: "starter",
      name: "Starter",
      credits: 1_000,
      amountCents: 1900,
      priceLabel: "$19",
      priceId: env.STRIPE_PRICE_STARTER,
    },
    {
      id: "growth",
      name: "Growth",
      credits: 6_000,
      amountCents: 8900,
      priceLabel: "$89",
      bonus: "20% extra credits",
      popular: true,
      priceId: env.STRIPE_PRICE_GROWTH,
    },
    {
      id: "scale",
      name: "Scale",
      credits: 25_000,
      amountCents: 29900,
      priceLabel: "$299",
      bonus: "32% extra credits",
      priceId: env.STRIPE_PRICE_SCALE,
    },
  ];
}

export function getPack(id: string): CreditPack | undefined {
  return listPacks().find((p) => p.id === id);
}

/**
 * Per-action credit costs. Tuned so that 1 credit ≈ $0.019 of retail value,
 * which covers wholesale + Stripe fee + VAT + a healthy profit margin.
 */
export interface CreditCost {
  tavily: number;            // per Tavily search call
  apolloMatch: number;       // per Apollo /people/match call
  llmTokensPerUnit: number;  // tokens that cost 1 credit (blended across providers)
}

export const CREDIT_COST: CreditCost = {
  tavily: 1,                 // $0.008 wholesale / $0.019 retail = 2.4× markup
  apolloMatch: 1,            // $0.00167 wholesale / $0.019 = 11× (high — enrichment has pricing power)
  llmTokensPerUnit: 2_000,   // ~2k tokens per credit covers up to Anthropic Sonnet rates
};

/** Convert token counts to credits. Round up so we never undercharge. */
export function tokensToCredits(tokens: number): number {
  return Math.ceil(tokens / CREDIT_COST.llmTokensPerUnit);
}
