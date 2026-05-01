/**
 * messaged-set — load the set of (normalized) names + LinkedIn URLs the
 * user has already MESSAGED (sent a message to). Network mode reads this
 * to:
 *   - tag matched prospects with a "📨 already messaged" signal so the
 *     user can see at a glance who they've already reached out to;
 *   - filter messaged people OUT entirely when the brief contains an
 *     "haven't messaged yet" / "not yet contacted" intent.
 *
 * The normalization functions are also called by the message-log route
 * when inserting rows, so the lookup keys match on read and write.
 */
import { db } from "../db/index.js";

export interface MessagedSet {
  names: Set<string>;
  linkedinUrls: Set<string>;
  /** Total number of distinct counterparts (sent OR received). Useful for
   *  surface text like "you've previously messaged 47 people". */
  totalCounterparts: number;
}

/** Lower-case, strip non-alphanumeric, collapse whitespace. Means
 *  "Burt H. Shannon Jr." and "Burt Shannon" both normalize to common
 *  forms — but we keep last-name strict, so "Burt" alone won't match. */
export function normalizeCounterpartName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drop scheme + www, lower-case the path up to /in/<slug>, strip query
 *  string and trailing slash. Two URLs that point at the same profile
 *  collapse to the same key regardless of the user's paste source. */
export function normalizeCounterpartLinkedIn(url: string): string {
  return url
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\?.*$/, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");
}

/** Pull every counterpart the user has SENT a message to. Used for the
 *  "haven't messaged" filter — people we've only RECEIVED from don't
 *  count, because the whole point is to find people the user hasn't
 *  reached out to yet. */
export async function loadMessagedSet(userId: string): Promise<MessagedSet> {
  const rows = await db
    .selectFrom("message_log")
    .select(["counterpart_name_normalized", "counterpart_linkedin_normalized", "direction"])
    .where("user_id", "=", userId)
    .where("direction", "=", "sent")
    .execute();

  const names = new Set<string>();
  const linkedinUrls = new Set<string>();
  for (const r of rows) {
    if (r.counterpart_name_normalized) names.add(r.counterpart_name_normalized);
    if (r.counterpart_linkedin_normalized) linkedinUrls.add(r.counterpart_linkedin_normalized);
  }

  // Cheap second query for the total-counterparts headline (sent + received).
  // Could fold into one trip but keeping them separate keeps the helper read-
  // only and easier to test.
  const totalRow = await db
    .selectFrom("message_log")
    .select((eb) => eb.fn.count<number>("id").distinct().as("c"))
    .where("user_id", "=", userId)
    .executeTakeFirst();

  return {
    names,
    linkedinUrls,
    totalCounterparts: Number(totalRow?.c ?? names.size),
  };
}

/** True when the candidate has been messaged — either name OR url match. */
export function hasMessaged(
  set: MessagedSet,
  candidate: { name?: string | null; linkedinUrl?: string | null },
): boolean {
  if (candidate.linkedinUrl) {
    const k = normalizeCounterpartLinkedIn(candidate.linkedinUrl);
    if (k && set.linkedinUrls.has(k)) return true;
  }
  if (candidate.name) {
    const k = normalizeCounterpartName(candidate.name);
    if (k && set.names.has(k)) return true;
  }
  return false;
}
