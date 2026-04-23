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
import { runFind } from "./find.js";
import type { UserKeys } from "../user-keys.js";

export async function runDiscoverMore(
  provider: AiProvider,
  originalBrief: string,
  excludeNames: string[],
  userId: string,
  userKeys?: UserKeys,
): Promise<CompletionResult> {
  return runFind(provider, originalBrief, userId, userKeys, [], excludeNames);
}
