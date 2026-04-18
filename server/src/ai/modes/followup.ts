/**
 * followup — the user has a prior result (a prospect list) and is asking a
 * question or refining. The LLM decides whether to answer in text or filter
 * the existing list, and returns either a CompletionResult of kind "text" or
 * kind "prospects" (subset of the previous list, preserving order).
 */
import type { AiProvider, CompletionResult, Prospect } from "@app/shared";
import { env } from "../../env.js";
import { aiJson } from "../json.js";
import type { UserKeys } from "../user-keys.js";

interface FollowupDecision {
  kind: "text" | "filter";
  content?: string;          // free-text answer when kind = "text"
  keepIds?: string[];         // subset of ids when kind = "filter"
  summary?: string;           // short summary for the filter case
}

export async function runFollowup(
  provider: AiProvider,
  userInput: string,
  previousProspects: Prospect[],
  userId: string,
  userKeys?: UserKeys,
): Promise<CompletionResult> {
  assertLlm(provider, userKeys);

  if (previousProspects.length === 0) {
    return {
      kind: "text",
      content: "No prior results to follow up on. Start a new search first.",
    };
  }

  // Keep the prompt lean — strip fields the LLM doesn't need for filtering.
  const compact = previousProspects.slice(0, 40).map((p) => ({
    id: p.id, name: p.name, title: p.title, company: p.company,
    loc: p.loc, email: p.email, phone: p.phone ?? undefined, linkedin: p.linkedin,
    signals: (p.signals ?? []).slice(0, 2),
    past: (p.past ?? []).slice(0, 2),
    matchPct: p.matchPct,
  }));

  const decision = await aiJson<FollowupDecision>(
    provider,
    "You help a user interrogate or filter a list of prospects they just saw. " +
    'Decide: is the user asking a question about the list (answer in text) or requesting a filter (return matching ids)? ' +
    'Output {"kind": "text"|"filter", "content"?, "keepIds"?, "summary"?}.',
    `User's message: ${userInput}\n\nPrior prospects:\n${JSON.stringify(compact)}\n\n` +
    `Rules:\n` +
    `- If the message is a filter/refinement ("only those with email", "just VPs", "remove the ones at Big Co", etc.), ` +
    `return kind="filter" with keepIds = ids that match, plus a one-line summary.\n` +
    `- If the message is a question ("do any of them work on AI safety?", "which one raised most recently?"), ` +
    `return kind="text" with content = a concise answer (≤ 3 sentences).\n` +
    `- Never invent info not present in the list.`,
    { maxTokens: 1500, userId, userKeys },
  );

  if (decision.kind === "filter") {
    const keep = new Set((decision.keepIds ?? []).map(String));
    const filtered = previousProspects.filter((p) => keep.has(String(p.id)));
    return {
      kind: "prospects",
      summary: decision.summary ?? `${filtered.length} match${filtered.length === 1 ? "" : "es"}.`,
      prospects: filtered,
    };
  }
  return {
    kind: "text",
    content: decision.content ?? "(no answer)",
  };
}

function assertLlm(provider: AiProvider, userKeys?: UserKeys) {
  const ok =
    provider === "openai" ? !!(userKeys?.openai ?? env.OPENAI_API_KEY) :
    provider === "anthropic" ? !!(userKeys?.anthropic ?? env.ANTHROPIC_API_KEY) :
    !!(userKeys?.deepseek ?? env.DEEPSEEK_API_KEY);
  if (!ok) throw new Error(`${provider.toUpperCase()} key missing — add it in Settings → API keys.`);
}
