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
/**
 * The URL to paste into Smartlead.
 *
 * Built from the request that asked for it, not from config. SERVER_URL
 * defaults to http://localhost:4000, so a deploy that never set it would hand
 * out a dead address — and nothing about that failure is visible: Smartlead
 * accepts the webhook, posts into the void, and replies simply never arrive.
 * The browser asking for this page reached us on the right host by definition,
 * so that host is the one to hand back. `trust proxy` is on, so req.protocol
 * and Host already reflect the public origin behind Railway's proxy.
 */
export function webhookUrl(token: string, req?: { protocol: string; get(h: string): string | undefined }): string {
  const host = req?.get("host");
  const base = host ? `${req!.protocol}://${host}` : env.SERVER_URL;
  return `${base}/hooks/smartlead/${token}`;
}

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
