/**
 * Personal opening lines: drafting them, reviewing them, and the global
 * approval queue that spans every board.
 *
 * Drafting costs a web lookup plus an LLM call per contact, so it always runs
 * as a background job — and the caller's BYO keys are captured while the
 * request headers still exist, then held in memory for that run only.
 */
import { Router, type Response } from "express";
import { z } from "zod";
import type { AuthedRequest } from "../../auth/session.js";
import { extractUserKeys } from "../../ai/user-keys.js";
import { getAccountByBoard } from "../../integrations/outreach/accounts.js";
import {
  autodraftAll, sortBoard, setOpener, listPending, pendingCount, undraftedCount, approveByIds,
} from "../../integrations/outreach/openers/index.js";
import { createJob, setProgress, finishJob, failJob } from "../../integrations/outreach/jobs.js";
import { uid, ownedBoard } from "./shared.js";
import { startSend, sendableCampaign } from "./sending.js";

const router = Router();

/** Run a drafting task as a job and return its id. */
async function startDraftJob(userId: string, run: (onProgress: (n: string) => void) => Promise<unknown>) {
  const jobId = await createJob(userId, "export");
  setImmediate(() => {
    run((n) => { void setProgress(jobId, n); })
      .then((r) => finishJob(jobId, r))
      .catch((err) => failJob(jobId, (err as Error).message));
  });
  return jobId;
}

/** Sort this board's people into groups now (re-sorting everyone if asked). */
router.post("/board/:boardId/sort", async (req: AuthedRequest, res: Response) => {
  const board = await ownedBoard(req);
  if (!board) return res.status(404).json({ error: "board_not_found" });
  const parsed = z.object({ resort: z.boolean().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  const userId = uid(req);
  const userKeys = extractUserKeys(req);
  res.json({
    jobId: await startDraftJob(userId, (onProgress) =>
      sortBoard(userId, board.id, { userKeys, resort: parsed.data.resort, onProgress })),
  });
});

// ── Global queue (all boards) ───────────────────────────────────────────────
router.get("/pending", async (req: AuthedRequest, res: Response) => {
  res.json({ pending: await listPending(uid(req)) });
});

/** Badge number, plus how many still need a line written. */
router.get("/pending/count", async (req: AuthedRequest, res: Response) => {
  const userId = uid(req);
  res.json({ count: await pendingCount(userId), undrafted: await undraftedCount(userId) });
});

/** Write every missing line across all switched-on boards. */
router.post("/pending/autodraft", async (req: AuthedRequest, res: Response) => {
  const userId = uid(req);
  const userKeys = extractUserKeys(req);
  res.json({ jobId: await startDraftJob(userId, (onProgress) => autodraftAll(userId, { userKeys, onProgress })) });
});

/**
 * Approve the chosen lines wherever they live, then send each affected
 * board+group. One button, any number of boards.
 */
router.post("/pending/approve-and-send", async (req: AuthedRequest, res: Response) => {
  const parsed = z.object({ ids: z.array(z.string().uuid()).min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const userId = uid(req);

  const groups = await approveByIds(userId, parsed.data.ids);
  const jobIds: string[] = [];
  for (const { board, group, ids } of groups) {
    // A group that can't send keeps its approval and goes out next time,
    // rather than failing the whole batch here.
    if (!(await getAccountByBoard(board)) || !(await sendableCampaign(board, group))) continue;
    // Send exactly the ticked people. Anyone with an approved line gets it
    // merged; anyone without receives the plain campaign template.
    jobIds.push(await startSend(userId, board, group, { contactIds: ids }));
  }
  res.json({ approved: parsed.data.ids.length, jobIds });
});

/** Hand-edit one line. Editing returns it to draft so approval stays deliberate. */
router.post("/contacts/:id/opener", async (req: AuthedRequest, res: Response) => {
  const parsed = z.object({ line: z.string().max(400) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const changed = await setOpener(uid(req), req.params.id, parsed.data.line);
  if (!changed) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

export default router;
