/**
 * Board-level setup: which boards exist, their connection to Smartlead, and
 * the on/off switch.
 *
 * Each board holds its own Smartlead account, so connecting one board never
 * affects another. Connecting stores a key and nothing else — a board only
 * sends once it is explicitly switched on.
 */
import { Router, type Response } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { db } from "../../db/index.js";
import type { AuthedRequest } from "../../auth/session.js";
import {
  connectAccount, getAccountByBoard, disconnectAccount, rotateWebhook, setAlertConfig,
} from "../../integrations/outreach/accounts.js";
import { listCampaigns } from "../../integrations/smartlead.js";
import { unreadAlertCount } from "../../integrations/outreach/alerts.js";
import { DEFAULT_PROMPT } from "../../integrations/outreach/openers/index.js";
import { uid, webhookUrl, ownedBoard, stopStagesOf } from "./shared.js";

const router = Router();

/** Events a board's webhook must be subscribed to in Smartlead. */
const WEBHOOK_EVENTS = [
  "EMAIL_SENT", "EMAIL_REPLY", "EMAIL_BOUNCE", "LEAD_UNSUBSCRIBED", "LEAD_CATEGORY_UPDATED",
];

/** Every board, with whether it's connected and switched on. */
router.get("/boards", async (req: AuthedRequest, res: Response) => {
  const userId = uid(req);
  const boards = await db
    .selectFrom("crm_boards")
    .select(["id", "name", "emoji", "outreach_enabled", "outreach_stage_map"])
    .where("user_id", "=", userId)
    .orderBy("created_at", "asc")
    .execute();
  const campaigns = await db
    .selectFrom("outreach_campaigns").selectAll().where("user_id", "=", userId).execute();
  const connected = new Set(
    (await db.selectFrom("smartlead_accounts").select("board_id").where("user_id", "=", userId).execute())
      .map((c) => c.board_id),
  );

  res.json({
    boards: boards.map((b) => ({
      ...b,
      connected: connected.has(b.id),
      campaigns: campaigns.filter((c) => c.board_id === b.id),
    })),
  });
});

/** One board's status — what the Automations page reads. */
router.get("/board/:boardId", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  const account = await getAccountByBoard(board.id);
  const campaigns = await db
    .selectFrom("outreach_campaigns").selectAll().where("board_id", "=", board.id).execute();
  const suppressions = await db
    .selectFrom("suppressions").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("user_id", "=", uid(req)).executeTakeFirst();

  res.json({
    boardId: board.id,
    name: board.name,
    connected: !!account,
    enabled: !!board.outreach_enabled,
    webhookUrl: account ? webhookUrl(account.webhookToken) : null,
    bounceThresholdPct: account?.bounceThresholdPct ?? 2,
    stopStages: stopStagesOf(board),
    openingPrompt: board.opening_prompt ?? "",
    defaultPrompt: DEFAULT_PROMPT,
    campaigns,
    suppressionCount: Number(suppressions?.n ?? 0),
    unreadAlerts: await unreadAlertCount(uid(req)),
  });
});

router.post("/board/:boardId/connect", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  const parsed = z.object({ apiKey: z.string().min(10) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  try {
    await listCampaigns(parsed.data.apiKey); // prove the key works before storing it
  } catch {
    return res.status(400).json({ error: "invalid_api_key" });
  }
  const { webhookToken, webhookSecret } = await connectAccount(uid(req), board.id, parsed.data.apiKey);
  res.json({ connected: true, webhookUrl: webhookUrl(webhookToken), webhookSecret, subscribeTo: WEBHOOK_EVENTS });
});

router.post("/board/:boardId/disconnect", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  await disconnectAccount(board.id);
  await db.updateTable("crm_boards").set({ outreach_enabled: false }).where("id", "=", board.id).execute();
  res.json({ ok: true });
});

router.post("/board/:boardId/rotate-webhook", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  if (!(await getAccountByBoard(board.id))) return res.status(400).json({ error: "not_connected" });
  const { webhookToken, webhookSecret } = await rotateWebhook(board.id);
  res.json({ webhookUrl: webhookUrl(webhookToken), webhookSecret });
});

/** The on/off switch. Turning a board off never un-pauses anyone already
 *  sending — it only stops new sends and stops card moves from acting. */
router.post("/board/:boardId/enabled", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  if (parsed.data.enabled && !(await getAccountByBoard(board.id))) {
    return res.status(400).json({ error: "not_connected" });
  }
  await db.updateTable("crm_boards")
    .set({ outreach_enabled: parsed.data.enabled, updated_at: new Date() as never })
    .where("id", "=", board.id).execute();
  res.json({ ok: true, enabled: parsed.data.enabled });
});

router.post("/board/:boardId/threshold", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  const parsed = z.object({ bounceThresholdPct: z.number().int().min(1).max(50) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  await setAlertConfig(board.id, parsed.data);
  res.json({ ok: true });
});

/**
 * The board's own instructions for writing opening lines. Blank restores the
 * built-in prompt. The non-negotiable rules (never invent, JSON shape) are
 * appended server-side, so a custom prompt can change the voice but cannot
 * switch off the safety.
 */
router.post("/board/:boardId/prompt", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  const parsed = z.object({ prompt: z.string().max(4000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  await db.updateTable("crm_boards")
    .set({ opening_prompt: parsed.data.prompt.trim() || null, updated_at: new Date() as never })
    .where("id", "=", board.id).execute();
  res.json({ ok: true });
});

/** Which of this board's stages mean "stop emailing". */
router.post("/board/:boardId/stop-stages", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  const parsed = z.object({ stages: z.array(z.string()).max(50) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const noSend = [...new Set(parsed.data.stages.map((s) => s.trim()).filter(Boolean))];
  await db.updateTable("crm_boards")
    .set({ outreach_stage_map: sql`${JSON.stringify({ noSend })}::jsonb` })
    .where("id", "=", board.id).execute();
  res.json({ ok: true, stages: noSend });
});

export default router;
