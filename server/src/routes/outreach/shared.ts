/**
 * Shared plumbing for the outreach routers.
 *
 * Every outreach endpoint is scoped to one CRM board owned by the caller, so
 * board resolution + ownership live here rather than being repeated in each
 * handler. `ownedBoard` returning null is always a 404 — a board you don't own
 * is indistinguishable from one that doesn't exist.
 */
import { db } from "../../db/index.js";
import { env } from "../../env.js";
import type { AuthedRequest } from "../../auth/session.js";

/** Content groups a contact can be placed in. */
/** A group is identified by its board-scoped id; see integrations/outreach/groups.ts. */
export type Group = string;

export const uid = (req: AuthedRequest): string => req.user!.id;

/** The inbound webhook URL for a board's Smartlead account. */
export const webhookUrl = (token: string): string => `${env.SERVER_URL}/hooks/smartlead/${token}`;

export interface OwnedBoard {
  id: string;
  name: string;
  outreach_enabled: boolean;
  outreach_stage_map: unknown;
  outreach_groups: unknown;
}

/** Resolve :boardId and assert the caller owns it. Null → respond 404. */
export async function ownedBoard(req: AuthedRequest): Promise<OwnedBoard | undefined> {
  const id = req.params.boardId;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  return db
    .selectFrom("crm_boards")
    .select(["id", "name", "outreach_enabled", "outreach_stage_map", "outreach_groups"])
    .where("id", "=", id)
    .where("user_id", "=", uid(req))
    .executeTakeFirst() as Promise<OwnedBoard | undefined>;
}

/** Stages chosen on a board as meaning "stop emailing these people". */
export function stopStagesOf(board: OwnedBoard): string[] {
  return ((board.outreach_stage_map ?? {}) as { noSend?: string[] }).noSend ?? [];
}
