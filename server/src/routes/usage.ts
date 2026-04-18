/**
 * GET /api/usage — month-to-date usage + current credit balance. Feeds the
 * Sidebar usage card and the Settings drawer.
 */
import { Router } from "express";
import type { AuthedRequest } from "../auth/session.js";
import { getCreditBalance, getMonthUsage } from "../usage/tracker.js";

const router = Router();

const CAPS = {
  apollo: Number(process.env.USAGE_CAP_APOLLO ?? 5_000),
  tavily: Number(process.env.USAGE_CAP_TAVILY ?? 10_000),
  llm_tokens: Number(process.env.USAGE_CAP_LLM_TOKENS ?? 5_000_000),
};

router.get("/", async (req: AuthedRequest, res) => {
  const [rows, balance] = await Promise.all([
    getMonthUsage(req.user!.id),
    getCreditBalance(req.user!.id),
  ]);

  const apolloCredits = rows.find((r) => r.provider === "apollo")?.totalCredits ?? 0;
  const tavilyCredits = rows.find((r) => r.provider === "tavily")?.totalCredits ?? 0;
  const llmTokens = rows
    .filter((r) => r.provider === "openai" || r.provider === "anthropic" || r.provider === "deepseek")
    .reduce((a, r) => a + r.totalTokens, 0);
  const costMicros = rows.reduce((a, r) => a + r.totalCostMicros, 0);

  res.json({
    balance,
    buckets: [
      { label: "Search", used: tavilyCredits, max: CAPS.tavily, unit: "" },
      { label: "Enrich", used: apolloCredits, max: CAPS.apollo, unit: "" },
      { label: "LLM", used: llmTokens, max: CAPS.llm_tokens, unit: "" },
    ],
    byProvider: rows,
    costUsd: costMicros / 1_000_000,
  });
});

export default router;
