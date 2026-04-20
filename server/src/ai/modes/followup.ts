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
    'Output {"kind": "text"|"filter", "content"?, "keepIds"?, "summary"?}. ' +
    "CRITICAL: content is shown DIRECTLY to the user as a chat reply. NEVER narrate your own reasoning process, " +
    'NEVER refer to "the user" in third person, NEVER say things like "The user\'s message is ambiguous" or ' +
    '"Based on the context" or "I cannot apply a filter". Speak TO the user in first person ("I can show you…", ' +
    '"Here\'s what I found…", or "Could you clarify whether you want X or Y?").',
    `User's message: ${userInput}\n\nPrior prospects:\n${JSON.stringify(compact)}\n\n` +
    `Rules:\n` +
    `- If the message is a filter/refinement ("only those with email", "just VPs", "remove the ones at Big Co", etc.), ` +
    `return kind="filter" with keepIds = ids that match, plus a one-line summary.\n` +
    `- If the message is a question ("do any of them work on AI safety?", "which one raised most recently?"), ` +
    `return kind="text" with content = a concise answer (≤ 3 sentences), addressed TO the user.\n` +
    `- If the message is a short directive that's too vague to act on ("do it", "this is what I want", "go ahead"), ` +
    `return kind="text" with content = a ONE-sentence clarifying question addressed TO the user. ` +
    `Example: "What would you like me to do — keep them all, filter by something, or start a new search?"\n` +
    `- Never invent info not present in the list. Never narrate internal reasoning.`,
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
  const rawContent = decision.content ?? "";
  return {
    kind: "text",
    content: sanitizeReasoningLeak(rawContent),
  };
}

/** Last-resort filter: some provider responses still slip meta-reasoning
 *  into the content field ("The user's message is ambiguous and does not…").
 *  If the content reads like third-person narration ABOUT the user rather
 *  than an answer TO the user, swap it for a neutral clarify. */
function sanitizeReasoningLeak(content: string): string {
  const t = content.trim();
  if (!t) return "Could you clarify what you'd like me to do with these results?";
  // Typical reasoning-leak openers DeepSeek emits when it's unsure.
  const leakPatterns = [
    /^the user(?:'s)?\s+(?:message|request|query|intent|clarification|statement)/i,
    /^based on the (?:context|above|prior)/i,
    /^(?:i cannot|unable to|without explicit)/i,
    /^this (?:is|seems|appears to be) (?:a|an)?\s*(?:statement|clarification|ambiguous|follow-up)/i,
  ];
  if (leakPatterns.some((re) => re.test(t))) {
    return "Could you clarify what you'd like me to do — keep the current list, filter it by something, or start a new search?";
  }
  return t;
}

function assertLlm(provider: AiProvider, userKeys?: UserKeys) {
  const ok =
    provider === "openai" ? !!(userKeys?.openai ?? env.OPENAI_API_KEY) :
    provider === "anthropic" ? !!(userKeys?.anthropic ?? env.ANTHROPIC_API_KEY) :
    !!(userKeys?.deepseek ?? env.DEEPSEEK_API_KEY);
  if (!ok) throw new Error(`${provider.toUpperCase()} key missing — add it in Settings → API keys.`);
}
