/**
 * Usage tracking (telemetry only).
 *
 * Stripe billing has been removed — users run against their own keys via
 * BYOK, or against server env keys without quota enforcement. We still
 * log every external call into usage_events for reporting and rate-limit
 * analysis, but no credits are deducted and no InsufficientCreditsError
 * is ever thrown.
 */
import { db } from "../db/index.js";

export type UsageProvider = "openai" | "anthropic" | "deepseek" | "tavily" | "apollo";
export type UsageKind = "chat" | "json" | "search" | "match" | "people_search";

// Micro-USD cost (wholesale), tracked for reporting.
const LLM_PRICING: Record<string, { input: number; output: number }> = {
  openai:    { input: 150_000,   output: 600_000 },
  anthropic: { input: 3_000_000, output: 15_000_000 },
  deepseek:  { input: 140_000,   output: 280_000 },
};
const NON_LLM_CREDIT_MICROS: Record<"tavily" | "apollo", number> = {
  tavily: 8_000,
  apollo: 1_667,
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

/** No-op stubs — kept so the rest of the AI stack compiles without changes. */
export async function reserveCredits(_userId: string, _cost: number): Promise<void> { /* noop */ }
export async function refundCredits(_userId: string, _cost: number): Promise<void> { /* noop */ }

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
