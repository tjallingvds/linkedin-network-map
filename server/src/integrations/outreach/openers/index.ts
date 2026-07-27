/**
 * Personal opening lines — the public surface.
 *
 * A line is drafted from what is known about the person (their LinkedIn via
 * Tavily, plus the CRM's own notes) AND from the campaign email it will open,
 * so it leads into that message. Lines are always created as drafts; only an
 * explicit approval releases them to Smartlead.
 */
export { contextFor, hasRealMaterial } from "./context.js";
export { research } from "./research.js";
export { draftOne, autodraftAll, promptFor, DEFAULT_PROMPT, type DraftResult } from "./draft.js";
export { sortOne, sortBoard, sortAll, acceptGroup, type SortResult } from "./sort.js";
export {
  setOpener, listPending, pendingCount, undraftedCount, approveByIds,
  type OpenerRow, type PendingRow,
} from "./queue.js";
