/**
 * "When this happens, move the card there."
 *
 * The operator writes rules in the board's own language:
 *
 *     when the email is sent      and the card is in New        → Contacted
 *     when they reply             and the card is in anything   → Replied
 *     when it bounces             and the card is in Contacted  → Bad address
 *
 * Rules are stored on `crm_boards.outreach_stage_map` next to the stop-sending
 * stages, because both are "what a stage means to outreach".
 *
 * Deliberate limits, so a rule can never do something surprising:
 *   - the first matching rule wins; rules are checked in the operator's order
 *   - a rule only fires when the card is currently in `from` (blank = any),
 *     so a card someone has already moved on isn't dragged backwards
 *   - moving a card into a stop-sending stage still stops sending, because
 *     the move goes through the same path a human drag does
 */
import { db } from "../../db/index.js";
import { onStageChange, sameStage } from "./stage-hook.js";

/** Things that can happen to an email. Named as the operator sees them. */
export const STAGE_TRIGGERS = ["sent", "replied", "bounced", "unsubscribed"] as const;
export type StageTrigger = (typeof STAGE_TRIGGERS)[number];

export interface StageRule {
  when: StageTrigger;
  /** Stage the card must currently be in. Empty/absent means any stage. */
  from?: string | null;
  /** Stage to move it to. */
  to: string;
}

/** Coerce whatever is stored into rules we are willing to act on. */
export function parseRules(raw: unknown): StageRule[] {
  const list = (raw as { rules?: unknown })?.rules;
  if (!Array.isArray(list)) return [];
  const out: StageRule[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const when = String(o.when ?? "") as StageTrigger;
    const to = typeof o.to === "string" ? o.to.trim() : "";
    if (!STAGE_TRIGGERS.includes(when) || !to) continue;
    const from = typeof o.from === "string" ? o.from.trim() : "";
    out.push({ when, from: from || null, to });
  }
  return out.slice(0, 20);
}

/**
 * The rule that applies, if any. `currentStage` is what the card is in now.
 *
 * Stage matching is forgiving on purpose. A board's stages live on the client,
 * so what reaches the server is sometimes the stage's id ("meeting") and
 * sometimes its label ("Meeting booked") depending on which screen saved it —
 * and a rule that silently never fires is indistinguishable from a broken
 * feature. Case, punctuation and a typo or two are all tolerated.
 */
export function ruleFor(
  rules: StageRule[],
  trigger: StageTrigger,
  currentStage: string | null,
): StageRule | null {
  for (const r of rules) {
    if (r.when !== trigger) continue;
    if (r.from && !sameStage(r.from, currentStage)) continue;
    if (sameStage(r.to, currentStage)) return null; // already there
    return r;
  }
  return null;
}

/**
 * Apply the board's rules for one contact after an email event.
 *
 * Fire-and-forget by contract: this runs off a webhook that has already been
 * acknowledged, so a failure here must never bubble. The move reuses the same
 * hook a human drag does, which is what keeps "moved into a stop stage" and
 * "stopped sending" from drifting apart.
 */
export async function applyStageRule(
  userId: string,
  contactId: string,
  trigger: StageTrigger,
): Promise<string | null> {
  try {
    const row = await db
      .selectFrom("crm_contacts as c")
      .innerJoin("crm_boards as b", "b.id", "c.board_id")
      .select(["c.stage as stage", "b.outreach_stage_map as map", "b.outreach_enabled as enabled"])
      .where("c.id", "=", contactId)
      .executeTakeFirst();
    if (!row?.enabled) return null;

    const rule = ruleFor(parseRules(row.map), trigger, row.stage ?? null);
    if (!rule) return null;

    // There is no server-side list of a board's stages to validate against —
    // stages live with the board on the client — so the destination is trusted
    // as saved. The picker only ever offers stages that exist, and a stage
    // later deleted leaves the card visible under "Other" rather than lost.

    await db.updateTable("crm_contacts")
      .set({ stage: rule.to, updated_at: new Date() as never })
      .where("id", "=", contactId)
      .execute();

    // Same path as a human drag: if the destination is a stop-sending stage,
    // the sequence pauses too.
    await onStageChange(userId, contactId, rule.to);
    return rule.to;
  } catch (err) {
    console.error(`[stage-rules] ${trigger} for ${contactId} failed:`, (err as Error).message);
    return null;
  }
}
