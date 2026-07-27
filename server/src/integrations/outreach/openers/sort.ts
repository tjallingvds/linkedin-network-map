/**
 * Sorting people into outreach groups.
 *
 * You describe what each group means in your own words ("Heads of AI at tier-1
 * banks", "insurers rebuilding claims", "everyone else"); this reads each
 * contact and files them accordingly. It is the step that decides who is
 * emailable at all, so it errs toward leaving someone out:
 *
 *   - a group with no description is never assigned to anyone
 *   - a contact who matches nothing stays ungrouped rather than being dumped
 *     into whichever group looks closest
 *   - the reason is stored next to the choice, so a wrong call is visible
 *     instead of silently deciding who gets email
 *
 * Anything set by hand is left alone — the sorter only fills gaps.
 */
import { db } from "../../../db/index.js";
import { aiJson } from "../../../ai/json.js";
import { availableProviders } from "../../../ai/providers.js";
import type { UserKeys } from "../../../ai/user-keys.js";

export type Group = "A" | "B" | "C";
export interface GroupDefs { A?: string; B?: string; C?: string }

export interface SortResult { considered: number; sorted: number; unmatched: number; failed: number }

const SYSTEM = `You sort a sales contact into one of the groups described below.

Rules:
1. Choose the group whose description the contact genuinely matches.
2. If the contact matches none of them — or you cannot tell from the facts
   given — return {"group": null}. That is a normal, expected answer. Never
   stretch someone into the closest-looking group.
3. Judge only on the facts supplied. Do not assume seniority, industry or
   company size that isn't stated.
4. "why" must be one short clause quoting the fact you used.

Return strict JSON: {"group": "A"|"B"|"C"|null, "why": string}`;

/** The facts we let the sorter see. */
function factsFor(c: {
  name: string; title: string | null; company: string | null;
  notes: string | null; background: string | null; custom_fields: unknown;
}): Record<string, string> {
  const f: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (s) f[k] = s.slice(0, 600);
  };
  put("name", c.name);
  put("job_title", c.title);
  put("company", c.company);
  put("notes", c.notes);
  put("background", c.background);
  for (const [k, v] of Object.entries((c.custom_fields ?? {}) as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) f[`custom_${k}`] = v.trim().slice(0, 300);
  }
  return f;
}

/**
 * Accept a group the sorter proposed — but only if the operator actually
 * described it. Guards against a made-up group ("D"), a group left blank, and
 * any non-answer, all of which mean "leave this person out".
 */
export function acceptGroup(raw: unknown, defs: GroupDefs): Group | null {
  const g = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!(["A", "B", "C"] as string[]).includes(g)) return null;
  return (defs[g as Group] ?? "").trim() ? (g as Group) : null;
}

/** Whether any group has been described at all. */
export function hasDescriptions(defs: GroupDefs): boolean {
  return (["A", "B", "C"] as Group[]).some((g) => (defs[g] ?? "").trim().length > 0);
}

/** Sort one contact. Returns null when nothing fits. */
export async function sortOne(
  defs: GroupDefs,
  facts: Record<string, string>,
  userId: string,
  userKeys?: UserKeys,
): Promise<{ group: Group | null; why: string }> {
  const providers = availableProviders(userKeys);
  if (!providers.length) throw new Error("no_ai_provider");

  const described = (["A", "B", "C"] as Group[])
    .filter((g) => (defs[g] ?? "").trim())
    .map((g) => `Group ${g}: ${defs[g]!.trim()}`)
    .join("\n");
  if (!described) return { group: null, why: "no groups described" };

  const out = await aiJson<{ group?: string | null; why?: string }>(
    providers[0]!,
    `${SYSTEM}\n\nThe groups:\n${described}`,
    JSON.stringify(facts),
    { maxTokens: 200, userId, userKeys },
  );
  const group = acceptGroup(out?.group, defs);
  return { group, why: typeof out?.why === "string" ? out.why.slice(0, 300) : "" };
}

/**
 * Sort every ungrouped contact on a board. Contacts that already have a group
 * are never touched — a hand-set group always wins over the sorter.
 */
export async function sortBoard(
  userId: string,
  boardId: string,
  opts: { userKeys?: UserKeys; onProgress?: (note: string) => void; resort?: boolean } = {},
): Promise<SortResult> {
  const board = await db
    .selectFrom("crm_boards").select(["outreach_groups", "outreach_enabled"])
    .where("id", "=", boardId).where("user_id", "=", userId).executeTakeFirst();
  if (!board?.outreach_enabled) return { considered: 0, sorted: 0, unmatched: 0, failed: 0 };

  const defs = (board.outreach_groups ?? {}) as GroupDefs;
  // No descriptions means no opinion about anyone — never guess.
  if (!hasDescriptions(defs)) return { considered: 0, sorted: 0, unmatched: 0, failed: 0 };

  let q = db
    .selectFrom("crm_contacts")
    .select(["id", "name", "title", "company", "notes", "background", "custom_fields"])
    .where("user_id", "=", userId)
    .where("board_id", "=", boardId)
    .where("email", "is not", null);
  // Only fill gaps unless a re-sort was asked for explicitly.
  if (!opts.resort) q = q.where("tier", "is", null);

  const contacts = await q.execute();
  const result: SortResult = { considered: contacts.length, sorted: 0, unmatched: 0, failed: 0 };
  if (!contacts.length) return result;

  // Fail loudly and once, rather than marking every single person "failed".
  if (!availableProviders(opts.userKeys).length) {
    throw new Error("Add an AI key under Manage API keys before sorting.");
  }

  let i = 0;
  for (const c of contacts) {
    i++;
    opts.onProgress?.(`sorting ${i}/${contacts.length}`);
    try {
      const { group, why } = await sortOne(defs, factsFor(c as never), userId, opts.userKeys);
      if (!group) {
        await db.updateTable("crm_contacts")
          .set({ group_reason: why || "Matched none of the groups" })
          .where("id", "=", c.id).execute();
        result.unmatched++;
        continue;
      }
      await db.updateTable("crm_contacts")
        .set({ tier: group, group_reason: why })
        .where("id", "=", c.id).execute();
      result.sorted++;
    } catch (err) {
      console.error(`[sort] ${c.id} failed:`, (err as Error).message);
      result.failed++;
    }
  }
  return result;
}

/** Sort every switched-on board the user owns. */
export async function sortAll(
  userId: string,
  opts: { userKeys?: UserKeys; onProgress?: (note: string) => void } = {},
): Promise<SortResult> {
  const boards = await db
    .selectFrom("crm_boards").select("id")
    .where("user_id", "=", userId).where("outreach_enabled", "=", true).execute();

  const total: SortResult = { considered: 0, sorted: 0, unmatched: 0, failed: 0 };
  for (const b of boards) {
    const r = await sortBoard(userId, b.id, opts);
    total.considered += r.considered;
    total.sorted += r.sorted;
    total.unmatched += r.unmatched;
    total.failed += r.failed;
  }
  return total;
}
