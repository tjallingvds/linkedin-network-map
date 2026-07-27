/**
 * After sending: results, warnings, the never-contact list, and manual
 * stop/resume.
 *
 * Suppression is deliberately account-wide, not per board — an opt-out has to
 * hold everywhere, whichever board the person happens to sit on.
 */
import { Router, type Response } from "express";
import { z } from "zod";
import { db } from "../../db/index.js";
import type { AuthedRequest } from "../../auth/session.js";
import { funnel } from "../../integrations/outreach/metrics.js";
import { listAlerts, markAlertsRead } from "../../integrations/outreach/alerts.js";
import { reconcileBoard } from "../../integrations/outreach/reconcile.js";
import {
  suppressEmail, blockDomain, pauseContactCampaigns, resumeContactCampaigns,
} from "../../integrations/outreach/suppress.js";
import { recordManualEvent } from "../../integrations/outreach/jobs.js";
import { uid, ownedBoard } from "./shared.js";

const router = Router();

/** Assert the caller owns this contact. */
async function ownsContact(userId: string, contactId: string): Promise<boolean> {
  const row = await db.selectFrom("crm_contacts").select("id")
    .where("id", "=", contactId).where("user_id", "=", userId).executeTakeFirst();
  return !!row;
}

router.get("/board/:boardId/metrics", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  res.json({ rows: await funnel(uid(req), board.id) });
});

router.get("/board/:boardId/alerts", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  res.json({ alerts: await listAlerts(uid(req), req.query.includeRead === "1", board.id) });
});

router.post("/alerts/read", async (req: AuthedRequest, res: Response) => {
  const parsed = z.object({ id: z.string().uuid().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  await markAlertsRead(uid(req), parsed.data.id);
  res.json({ ok: true });
});

router.post("/board/:boardId/reconcile", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  res.json(await reconcileBoard(board.id));
});

/** Never contact — one person, or a whole company. Applies to every board. */
router.post("/suppress", async (req: AuthedRequest, res: Response) => {
  const parsed = z
    .object({
      email: z.string().email().optional(),
      domain: z.string().min(3).optional(),
      reason: z.enum(["opt_out", "compliance", "bounce_hard", "manual"]).default("manual"),
    })
    .refine((v) => !!v.email !== !!v.domain, { message: "provide exactly one of email|domain" })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const userId = uid(req);

  if (parsed.data.email) {
    await suppressEmail(userId, parsed.data.email, parsed.data.reason);
    await recordManualEvent(userId, "MANUAL_SUPPRESS", { email: parsed.data.email, actorId: userId, note: parsed.data.reason });
  } else {
    const reason = parsed.data.reason === "compliance" ? "compliance" : "manual";
    await blockDomain(userId, parsed.data.domain!, reason);
    await recordManualEvent(userId, "MANUAL_DOMAIN_BLOCK", { email: parsed.data.domain, actorId: userId, note: reason });
  }
  res.json({ ok: true });
});

router.post("/contacts/:id/pause", async (req: AuthedRequest, res: Response) => {
  const userId = uid(req);
  if (!(await ownsContact(userId, req.params.id))) return res.status(404).json({ error: "not_found" });
  await pauseContactCampaigns(userId, req.params.id);
  await recordManualEvent(userId, "MANUAL_PAUSE", { contactId: req.params.id, actorId: userId });
  res.json({ ok: true });
});

router.post("/contacts/:id/resume", async (req: AuthedRequest, res: Response) => {
  const userId = uid(req);
  if (!(await ownsContact(userId, req.params.id))) return res.status(404).json({ error: "not_found" });
  await resumeContactCampaigns(req.params.id);
  await recordManualEvent(userId, "MANUAL_RESUME", { contactId: req.params.id, actorId: userId });
  res.json({ ok: true });
});

export default router;
