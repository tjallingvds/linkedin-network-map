/**
 * discover_more — "find me more people like this". Delegates to runFind so
 * the full quality pipeline (clarify, archetype gate, snippet grounding,
 * cross-turn dedup) applies. Previously this mode had its own thin 3-query
 * extract pipeline which routinely produced (a) prospects with the title
 * written into the name field, (b) fabricated people, and (c) sector-
 * coverage bankers masquerading as AI leads. Keeping the logic in one
 * place stops that drift.
 */
import type { AiProvider, CompletionResult } from "@app/shared";
import { runFind, type MatchBreadth, type PriorMessage } from "./find.js";
import type { UserKeys } from "../user-keys.js";

export async function runDiscoverMore(
  provider: AiProvider,
  originalBrief: string,
  excludeNames: string[],
  userId: string,
  userKeys?: UserKeys,
  matchBreadth: MatchBreadth = "broad",
  // Full chat history for this branch. Previously this was []  — which made
  // discover_more BLIND to the conversation and dependent entirely on the
  // client-supplied previousBrief. When that brief had degraded to a fragment
  // (e.g. just the count "100" after the ICP was sent on an earlier turn),
  // the ICP characteristics were lost and the search free-associated into
  // competitors. Passing the real branch history rebuilds the full brief
  // server-side regardless of what the client cached.
  priorMessages: PriorMessage[] = [],
): Promise<CompletionResult> {
  return runFind(provider, originalBrief, userId, userKeys, priorMessages, excludeNames, matchBreadth);
}
