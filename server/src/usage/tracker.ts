/**
 * Real usage tracking + credit deduction.
 *
 * Every external call:
 *   1. Computes credit cost from billing/packs.ts CREDIT_COST.
 *   2. Atomically deducts from user.credit_balance (a single UPDATE with a
 *      guard on balance >= cost; rejects if insufficient).
 *   3. Writes a usage_events row for reporting.
 *
 * If `reserveCredits()` returns 0 affected rows, the caller should throw
 * `InsufficientCreditsError` BEFORE making the external call, so the user
 * can't drain Apollo/Tavily quota on 402 errors.
 */
import { db } from "../db/index.js";
import { CREDIT_COST, tokensToCredits } from "../billing/packs.js";

export class InsufficientCreditsError extends Error {
  code = "insufficient_credits" as const;
  constructor(public requiredCredits: number, public currentBalance: number) {
    super(`Not enough credits (need ${requiredCredits}, have ${currentBalance}).`);
  }
}

export type UsageProvider = "openai" | "anthropic" | "deepseek" | "tavily" | "apollo";
export type UsageKind = "chat" | "json" | "search" | "match" | "people_search";

// Micro-USD cost (wholesale). Still tracked for accounting even though the
// user pays in credits, so we can see our true margin in reports.
const LLM_PRICING: Record<string, { input: number; output: number }> = {
  openai:    { input: 150_000,   output: 600_000 },
  anthropic: { input: 3_000_000, output: 15_000_000 },
  deepseek:  { input: 140_000,   output: 280_000 },
};
const NON_LLM_CREDIT_MICROS: Record<"tavily" | "apollo", number> = {
  tavily: 8_000,  // $0.008 per search
  apollo: 1_667,  // $10 / 6000 emails
};

export interface RecordUsageInput {
  userId: string;
  provider: UsageProvider;
  kind: UsageKind;
  inputTokens?: number;
  outputTokens?: number;
  credits?: number;
  metadata?: unknown;
}

/**
 * Compute the credit cost of an action. For LLMs we round up by 1000 tokens.
 */
export function creditCostFor(input: RecordUsageInput): number {
  if (input.provider === "tavily") return CREDIT_COST.tavily * (input.credits ?? 1);
  if (input.provider === "apollo") return CREDIT_COST.apolloMatch * (input.credits ?? 1);
  const tokens = (input.inputTokens ?? 0) + (input.outputTokens ?? 0);
  return tokensToCredits(tokens);
}

/**
 * Reserve credits BEFORE an external call. Atomic: if the UPDATE returns
 * no rows, the user didn't have enough.
 *
 * For LLM calls where token counts come back after the call, reserve an
 * estimate first, then reconcile with `recordUsage()` which logs the real
 * numbers. (The small gap between estimate and actual is rounding noise.)
 */
export async function reserveCredits(userId: string, cost: number): Promise<number> {
  if (cost <= 0) return 0;
  const row = await db
    .updateTable("users")
    .set((eb) => ({ credit_balance: eb("credit_balance", "-", cost) }))
    .where("id", "=", userId)
    .where("credit_balance", ">=", cost)
    .returning("credit_balance")
    .executeTakeFirst();

  if (!row) {
    const current = await db
      .selectFrom("users")
      .select("credit_balance")
      .where("id", "=", userId)
      .executeTakeFirst();
    throw new InsufficientCreditsError(cost, current?.credit_balance ?? 0);
  }
  return row.credit_balance;
}

export async function refundCredits(userId: string, cost: number): Promise<void> {
  if (cost <= 0) return;
  await db
    .updateTable("users")
    .set((eb) => ({ credit_balance: eb("credit_balance", "+", cost) }))
    .where("id", "=", userId)
    .execute();
}

/** Log the final usage event. Credits were already deducted by reserve. */
export async function recordUsage(input: RecordUsageInput): Promise<void> {
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const credits = input.credits ?? 1;

  let costMicros = 0n;
  const llmPrice = LLM_PRICING[input.provider];
  if (llmPrice) {
    costMicros =
      BigInt(Math.round((inputTokens * llmPrice.input) / 1_000_000)) +
      BigInt(Math.round((outputTokens * llmPrice.output) / 1_000_000));
  } else if (input.provider === "tavily" || input.provider === "apollo") {
    costMicros = BigInt(NON_LLM_CREDIT_MICROS[input.provider] * credits);
  }

  try {
    await db
      .insertInto("usage_events")
      .values({
        user_id: input.userId,
        provider: input.provider,
        kind: input.kind,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        credits,
        cost_micros: costMicros,
        metadata: input.metadata ?? null,
      })
      .execute();
  } catch (err) {
    console.warn("usage tracking failed:", (err as Error).message);
  }
}

/** Month-to-date aggregates + credit balance. */
export interface UsageRow {
  provider: UsageProvider;
  totalTokens: number;
  totalCredits: number;
  totalCostMicros: number;
  calls: number;
}

export async function getMonthUsage(userId: string): Promise<UsageRow[]> {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .selectFrom("usage_events")
    .select(({ fn }) => [
      "provider",
      fn.count<number>("id").as("calls"),
      fn.sum<string | number>("input_tokens").as("in_tokens"),
      fn.sum<string | number>("output_tokens").as("out_tokens"),
      fn.sum<string | number>("credits").as("credits"),
      fn.sum<string | number>("cost_micros").as("cost_micros"),
    ])
    .where("user_id", "=", userId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .where("created_at", ">=", start as any)
    .groupBy("provider")
    .execute();

  return rows.map((r) => ({
    provider: r.provider as UsageProvider,
    calls: Number(r.calls) || 0,
    totalTokens: (Number(r.in_tokens) || 0) + (Number(r.out_tokens) || 0),
    totalCredits: Number(r.credits) || 0,
    totalCostMicros: Number(r.cost_micros) || 0,
  }));
}

export async function getCreditBalance(userId: string): Promise<number> {
  const row = await db
    .selectFrom("users")
    .select("credit_balance")
    .where("id", "=", userId)
    .executeTakeFirst();
  return row?.credit_balance ?? 0;
}
