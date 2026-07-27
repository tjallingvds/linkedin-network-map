/**
 * Which group goes to which Smartlead campaign, who is ready, and who is
 * skipped and why.
 *
 * Sending itself is NOT triggered here: every contact goes out through the
 * approval queue, so a human has always seen them first. `startSend` is the
 * shared job-runner that queue uses — a real push (batches of 400 plus a
 * lead-id sweep) runs far longer than the platform's request cap, so it can
 * never happen inline.
 */
import { Router, type Response } from "express";
import { z } from "zod";
import { db } from "../../db/index.js";
import type { AuthedRequest } from "../../auth/session.js";
import { getAccountByBoard } from "../../integrations/outreach/accounts.js";
import { listCampaigns } from "../../integrations/smartlead.js";
import { selectEligible, selectExcluded, exportTier } from "../../integrations/outreach/gate.js";
import { createJob, setProgress, finishJob, failJob, getJob } from "../../integrations/outreach/jobs.js";
import { uid, ownedBoard } from "./shared.js";
import { listGroups } from "../../integrations/outreach/groups.js";

const router = Router();

/** Start an export as a job and hand back its id. Shared by the plain send and
 *  the approve-and-send flow, so both behave identically. */
export async function startSend(
  userId: string,
  boardId: string,
  group: string,
  opts: { requireOpener?: boolean; contactIds?: string[] } = {},
): Promise<string> {
  const jobId = await createJob(userId, "export");
  setImmediate(() => {
    exportTier(userId, {
      tier: group,
      boardId,
      requireOpener: opts.requireOpener,
      contactIds: opts.contactIds,
      onProgress: (note) => { void setProgress(jobId, note); },
    })
      .then((result) => finishJob(jobId, result))
      .catch((err) => failJob(jobId, (err as Error).message));
  });
  return jobId;
}

/** Is this board+group actually able to send? */
export async function sendableCampaign(boardId: string, group: string) {
  return db
    .selectFrom("outreach_campaigns").select("id")
    .where("board_id", "=", boardId).where("tier", "=", group).where("state", "=", "active")
    .executeTakeFirst();
}

// ── Groups → campaigns ──────────────────────────────────────────────────────
router.get("/board/:boardId/campaigns", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  res.json({
    campaigns: await db.selectFrom("outreach_campaigns").selectAll().where("board_id", "=", board.id).execute(),
  });
});

router.get("/board/:boardId/campaigns/remote", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  const account = await getAccountByBoard(board.id);
  if (!account) return res.status(400).json({ error: "not_connected" });
  res.json({ campaigns: await listCampaigns(account.apiKey) });
});

router.post("/board/:boardId/campaigns", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  const parsed = z.object({
    group: z.string().min(1).max(64),
    providerCampaignId: z.string().min(1),
    name: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const { group, providerCampaignId, name } = parsed.data;

  const row = await db
    .insertInto("outreach_campaigns")
    .values({
      user_id: uid(req), board_id: board.id,
      provider_campaign_id: providerCampaignId, tier: group, name: name ?? null,
    })
    // Re-pointing a group at a different campaign replaces the mapping.
    .onConflict((oc) => oc.columns(["board_id", "tier"]).doUpdateSet({
      provider_campaign_id: providerCampaignId, name: name ?? null, updated_at: new Date(),
    }))
    .returningAll()
    .executeTakeFirst();
  res.json({ campaign: row });
});

// ── Readiness / who's skipped / preview ─────────────────────────────────────
router.get("/board/:boardId/readiness", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  const userId = uid(req);

  const rows = await db
    .selectFrom("crm_contacts").select(["id", "email", "tier"])
    .where("board_id", "=", board.id).where("user_id", "=", userId).execute();

  const groups = await listGroups(board.id);
  const byGroup: Record<string, number> = {};
  const ready: Record<string, number> = {};
  for (const g of groups) { byGroup[g.id] = 0; ready[g.id] = 0; }
  for (const r of rows) if (r.tier && r.tier in byGroup) byGroup[r.tier]++;

  // Ready counts run the real filter, so this can never disagree with a send.
  for (const g of groups) {
    ready[g.id] = (await selectEligible(userId, { tier: g.id, boardId: board.id })).length;
  }

  const campaigns = await db
    .selectFrom("outreach_campaigns").select(["tier"])
    .where("board_id", "=", board.id).where("state", "=", "active").execute();

  res.json({
    connected: !!(await getAccountByBoard(board.id)),
    enabled: !!board.outreach_enabled,
    total: rows.length,
    withEmail: rows.filter((r) => !!r.email).length,
    byGroup, ready,
    mappedGroups: campaigns.map((c) => c.tier),
  });
});

router.get("/board/:boardId/excluded", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  res.json({ excluded: await selectExcluded(uid(req), board.id) });
});

router.get("/board/:boardId/preview", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  const parsed = z.object({ group: z.string().min(1).max(64) }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_query" });
  const list = await selectEligible(uid(req), { tier: parsed.data.group, boardId: board.id, limit: 2000 });
  res.json({
    group: parsed.data.group,
    readyCount: list.length,
    sample: list.slice(0, 10).map((c) => ({ id: c.id, name: c.name, email: c.email })),
  });
});

// ── Send ────────────────────────────────────────────────────────────────────
// There is deliberately NO "send this whole group" endpoint. Every contact
// reaches Smartlead through the approval queue (POST /pending/approve-and-send),
// so nothing is ever emailed that a human hasn't seen on the Need-approval
// screen — including people who have no personal line and will receive the
// plain campaign template.

router.get("/send/:jobId", async (req: AuthedRequest, res: Response) => {
  const job = await getJob(req.params.jobId, uid(req));
  if (!job) return res.status(404).json({ error: "not_found" });
  res.json(job);
});

export default router;
