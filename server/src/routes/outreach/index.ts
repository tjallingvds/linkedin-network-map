/**
 * Email outreach API, mounted at /api/outreach.
 *
 * Split by what the operator is doing, not by HTTP shape:
 *   boards      — connect a board, switch it on, choose its stop stages
 *   sending     — groups → campaigns, who's ready, who's skipped, send
 *   approvals   — draft opening lines, review them, approve (global queue)
 *   monitoring  — results, warnings, never-contact, manual stop/resume
 *
 * Everything is scoped to one CRM board owned by the caller, except the
 * never-contact list and the approval queue, which deliberately span boards.
 */
import { Router } from "express";
import boards from "./boards.js";
import sending from "./sending.js";
import approvals from "./approvals.js";
import monitoring from "./monitoring.js";

const router = Router();
router.use(boards);
router.use(sending);
router.use(approvals);
router.use(monitoring);

export default router;
