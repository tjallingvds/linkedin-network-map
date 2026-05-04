/**
 * CRM read — chat fast path that answers questions about the user's own
 * CRM contents. Fires when the user asks something like:
 *   "what's in my Banks board?"
 *   "list the technical people in my Sales Pipeline CRM"
 *   "who's the most senior person in my CRM?"
 *   "summarise my outreach pipeline board"
 *   "find duplicates in my CRM"
 *
 * Unlike runFind / runDecisionMakers / runPersonBackground, this branch
 * NEVER hits Tavily. It pulls contacts straight from the DB and lets the
 * LLM answer against the structured data. Cheap, fast, and lossless —
 * the user's own CRM is the source of truth, no web inference needed.
 *
 * Returns { kind: "text", content: markdown } so the answer renders in
 * the chat's ai-summary block (same surface as decision-maker maps and
 * person-background blurbs).
 */
import type { AiProvider, CompletionResult } from "@app/shared";
import { db } from "../../db/index.js";
import { aiJson } from "../json.js";
import type { UserKeys } from "../user-keys.js";

/** Trigger condition. Matches messages that explicitly point at the
 *  user's OWN CRM/board, not at a generic "find prospects" prompt that
 *  happens to mention the word "CRM".
 *
 *  Detection is intentionally narrow — false positives would hijack
 *  legitimate prospecting briefs that contain "CRM" as an exclusion
 *  signal ("not in CRM yet"). Two signals required:
 *    1. A possessive/reference to the user's own data: "my CRM",
 *       "my board(s)", "the X board", "in my X".
 *    2. A read-style verb or question: "what's in", "show me",
 *       "list", "summarise", "who's", "how many", "search", "find …
 *       in my", "are there", "find duplicates", etc.
 *
 *  Length cap mirrors the person-background guard: structured prospecting
 *  briefs (>800 chars) are not CRM-read questions even if they mention a
 *  board name.
 */
export function looksLikeCrmRead(s: string): boolean {
  if (s.length > 800) return false;
  const hay = s.toLowerCase();

  const possessive =
    /\bmy\s+(?:crm|board|boards|pipeline|contacts?)\b/.test(hay) ||
    /\b(?:in|on|across|from)\s+my\s+(?:crm|board|boards|pipeline|contacts?)\b/.test(hay) ||
    /\b(?:in|on|across|from)\s+(?:the\s+)?[a-z][a-z0-9\s\-&]{1,40}?\s+(?:board|crm|pipeline)\b/.test(hay) ||
    /\b(?:our|the)\s+(?:crm|pipeline)\b/.test(hay);
  if (!possessive) return false;

  const readIntent =
    /\b(?:what(?:'s|\s+is)?\s+in|show\s+me|list|enumerate|summari[sz]e|tell\s+me\s+about|describe|recap)\b/.test(hay) ||
    /\b(?:who(?:'s|\s+is)|how\s+many|how\s+much|count|are\s+there|is\s+there|do\s+i\s+have)\b/.test(hay) ||
    /\b(?:find|search|look\s+(?:up|for)|filter|pull)\b\s+[\s\S]{0,80}\b(?:in|across|from|on)\s+my\b/.test(hay) ||
    /\b(?:duplicates?|stale|untouched|empty|missing|incomplete)\b/.test(hay) ||
    /\b(?:read|check)\s+(?:my\s+)?(?:crm|board|pipeline)\b/.test(hay);
  return readIntent;
}

interface BoardSummary {
  id: string;
  name: string;
  emoji: string | null;
  contactCount: number;
}

interface ResolveTarget {
  /** Board name or fragment the user referenced ("Banks", "Sales Pipeline").
   *  null when the user said "my CRM" without naming a specific board. */
  boardHint: string | null;
  /** The actual question to answer against the data. Stripped of the
   *  "in my X board" framing so the answer LLM gets a clean prompt. */
  question: string;
}

export async function runCrmRead(args: {
  provider: AiProvider;
  brief: string;
  userId: string;
  userKeys?: UserKeys;
}): Promise<CompletionResult | null> {
  const { provider, brief, userId, userKeys } = args;

  // 1. List the user's accessible boards (owned + shared). This is the
  //    universe of boards we can resolve a name against.
  const boards = await listUserBoards(userId);
  if (boards.length === 0) {
    return {
      kind: "text",
      content: "You don't have any CRM boards yet. Open the CRM tab and create one — then ask me about it.",
    };
  }

  // 2. Parse the user's intent — which board, what question.
  const target = await parseTarget(provider, brief, boards, userId, userKeys);
  if (!target) {
    // LLM couldn't extract a question. Fall back to the generic Find
    // pipeline rather than answer something we don't understand.
    return null;
  }

  // 3. Resolve the board reference to one or more board ids.
  const resolved = resolveBoards(target.boardHint, boards);
  if (resolved.kind === "ambiguous") {
    const list = resolved.candidates.map((b) => `- **${b.name}** (${b.contactCount} contacts)`).join("\n");
    return {
      kind: "text",
      content:
        `You have several boards that could match. Which one did you mean?\n\n${list}\n\n` +
        `Re-ask with the board's name in the question, e.g. *"what's in my ${resolved.candidates[0]!.name} board?"*`,
    };
  }
  if (resolved.kind === "unknown") {
    const list = boards.map((b) => `- ${b.name}`).join("\n");
    return {
      kind: "text",
      content:
        `I couldn't find a board called "${target.boardHint}". Your boards:\n\n${list}\n\n` +
        `Re-ask with one of those names.`,
    };
  }

  // 4. Pull contacts. When the user said "my CRM" with no board name we
  //    pull across all boards; otherwise just the matched board.
  const boardIds = resolved.boards.map((b) => b.id);
  const contacts = await loadContacts(boardIds);
  const columnsByBoard = await loadColumnSchemas(boardIds);

  // 5. Build the LLM context. Keep it under ~80K input tokens by trimming
  //    obvious bulk fields (background, notes) to a fixed length per row.
  //    Most boards are well under 200 contacts, so this rarely triggers.
  const MAX_ROWS = 300;
  const truncated = contacts.slice(0, MAX_ROWS);
  const truncatedNote = contacts.length > MAX_ROWS
    ? `\n\n(Note: showing first ${MAX_ROWS} of ${contacts.length} contacts. Ask a narrower question if you need to see more.)`
    : "";

  const context = formatContactsForLLM(truncated, columnsByBoard, resolved.boards);

  // 6. Answer the question. The system prompt tells the LLM that this is
  //    structured CRM data — not web search results — so it should not
  //    invent facts beyond what's in the rows.
  try {
    const out = await aiJson<{ answer: string }>(
      provider,
      `You answer questions about the user's own CRM. The data below is the source of truth — do NOT invent facts that aren't in the rows. Do NOT pull from training data.

Rules:
- Answer in markdown. Use a table when the user asks for a list or filter; use prose for summary/aggregate questions.
- Cite specific contacts by name where relevant.
- If the answer is "no contacts match", say so directly — do not pad with caveats.
- If the user asks for something the data can't answer (e.g. "who replied last week" but no replies are tracked), say what's missing rather than guessing.
- Custom-field column labels are listed at the top of each board section; use those labels when referring to fields, not internal IDs.

Keep the answer focused. Single question → single answer. No preamble like "based on your CRM…".${truncatedNote}`,
      `QUESTION:\n${target.question}\n\nCRM DATA:\n${context}\n\nReturn {"answer": "<markdown answer>"}.`,
      { maxTokens: 2500, userId, userKeys },
    );
    const answer = out.answer?.trim();
    if (!answer) return null;
    return { kind: "text", content: answer };
  } catch (e) {
    console.warn("[crm-read] aiJson failed:", (e as Error).message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────

async function listUserBoards(userId: string): Promise<BoardSummary[]> {
  // Boards the user owns + boards shared to them.
  const memberRows = await db
    .selectFrom("crm_board_members")
    .select("board_id")
    .where("user_id", "=", userId)
    .execute();
  const sharedIds = memberRows.map((m) => m.board_id);

  const rows = await db
    .selectFrom("crm_boards")
    .leftJoin("crm_contacts", "crm_contacts.board_id", "crm_boards.id")
    .select(({ fn }) => [
      "crm_boards.id",
      "crm_boards.name",
      "crm_boards.emoji",
      fn.count<number>("crm_contacts.id").as("contact_count"),
    ])
    .where((eb) =>
      sharedIds.length > 0
        ? eb.or([eb("crm_boards.user_id", "=", userId), eb("crm_boards.id", "in", sharedIds)])
        : eb("crm_boards.user_id", "=", userId),
    )
    .groupBy(["crm_boards.id"])
    .orderBy("crm_boards.created_at", "asc")
    .execute();

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    emoji: r.emoji,
    contactCount: Number(r.contact_count) || 0,
  }));
}

async function parseTarget(
  provider: AiProvider,
  brief: string,
  boards: BoardSummary[],
  userId: string,
  userKeys?: UserKeys,
): Promise<ResolveTarget | null> {
  // Pass the user's actual board names to the LLM so it can pick the
  // intended one even when the user shortens or paraphrases the name
  // ("Banks" → "Sales Pipeline Banks", "outreach" → "Outreach pipeline").
  const boardList = boards.map((b) => `- ${b.name}`).join("\n");
  try {
    const out = await aiJson<{ boardHint: string | null; question: string }>(
      provider,
      `You parse a user message that asks about THEIR OWN CRM. Extract two fields:

  boardHint: the board the user is referring to. Match against this list of their actual boards (use the EXACT name from the list when there's a clear match, even if the user shortened it):
${boardList}
    - If the user clearly named a specific board ("my Banks board", "the Sales Pipeline"), return the matching name from the list.
    - If the user said "my CRM" / "my contacts" / "across all my boards" with no specific board, return null.
    - If the user named a board that ISN'T in the list, return their phrasing verbatim (we'll surface a "no such board" error).

  question: the actual thing the user wants to know about the data, with the "in my X board" framing stripped out so the downstream answer prompt gets a clean question.
    - Example: "what's in my Sales Pipeline Banks board?" → question = "what's in this board?"
    - Example: "list the technical people in my CRM" → question = "list the technical people"
    - Example: "summarise my outreach board for me" → question = "summarise this board"

Return ONLY {"boardHint": "<name from list, user verbatim, or null>", "question": "<clean question>"}.`,
      brief,
      { maxTokens: 300, userId, userKeys },
    );
    const question = out.question?.trim();
    if (!question) return null;
    const boardHint = typeof out.boardHint === "string" && out.boardHint.trim() ? out.boardHint.trim() : null;
    return { boardHint, question };
  } catch (e) {
    console.warn("[crm-read] parseTarget failed:", (e as Error).message);
    return null;
  }
}

type ResolveResult =
  | { kind: "matched"; boards: BoardSummary[] }
  | { kind: "ambiguous"; candidates: BoardSummary[] }
  | { kind: "unknown" };

function resolveBoards(hint: string | null, boards: BoardSummary[]): ResolveResult {
  if (!hint) {
    // No specific board — answer across all of them. The LLM context will
    // group by board so the answer can still cite which board a contact
    // sits on.
    return { kind: "matched", boards };
  }
  const norm = hint.toLowerCase().trim();
  // Exact match (case-insensitive).
  const exact = boards.filter((b) => b.name.toLowerCase() === norm);
  if (exact.length === 1) return { kind: "matched", boards: exact };
  // Substring match either direction — "Banks" matches "Sales Pipeline Banks",
  // "outreach pipeline" matches "Outreach Pipeline".
  const sub = boards.filter(
    (b) => b.name.toLowerCase().includes(norm) || norm.includes(b.name.toLowerCase()),
  );
  if (sub.length === 1) return { kind: "matched", boards: sub };
  if (sub.length > 1) return { kind: "ambiguous", candidates: sub };
  return { kind: "unknown" };
}

interface ContactRow {
  id: string;
  board_id: string;
  name: string;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  stage: string | null;
  background: string | null;
  notes: string | null;
  custom_fields: Record<string, string> | null;
  updated_at: Date | string | null;
}

async function loadContacts(boardIds: string[]): Promise<ContactRow[]> {
  if (boardIds.length === 0) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await db
    .selectFrom("crm_contacts")
    .select([
      "id", "board_id", "name", "title", "company", "email", "phone", "linkedin",
      "stage", "background", "notes", "custom_fields", "updated_at",
    ])
    .where("board_id", "in", boardIds)
    .orderBy("updated_at", "desc")
    .execute();
  return rows as unknown as ContactRow[];
}

interface ColumnDef {
  id: string;
  builtin?: boolean;
  label?: string;
  type?: string;
}

async function loadColumnSchemas(boardIds: string[]): Promise<Map<string, ColumnDef[]>> {
  const m = new Map<string, ColumnDef[]>();
  if (boardIds.length === 0) return m;
  const rows = await db
    .selectFrom("crm_boards")
    .select(["id", "columns"])
    .where("id", "in", boardIds)
    .execute();
  for (const r of rows) {
    const cols = Array.isArray(r.columns) ? (r.columns as ColumnDef[]) : [];
    m.set(r.id, cols);
  }
  return m;
}

function formatContactsForLLM(
  contacts: ContactRow[],
  columnsByBoard: Map<string, ColumnDef[]>,
  boards: BoardSummary[],
): string {
  // Group by board so the LLM can answer "across all my boards" questions
  // and still attribute each row to its board.
  const byBoard = new Map<string, ContactRow[]>();
  for (const c of contacts) {
    const list = byBoard.get(c.board_id) ?? [];
    list.push(c);
    byBoard.set(c.board_id, list);
  }
  const sections: string[] = [];
  for (const board of boards) {
    const rows = byBoard.get(board.id) ?? [];
    if (rows.length === 0) {
      sections.push(`### Board: ${board.name} (empty)`);
      continue;
    }
    const cols = columnsByBoard.get(board.id) ?? [];
    const customCols = cols.filter((c) => !c.builtin);
    const header = customCols.length > 0
      ? `Custom columns: ${customCols.map((c) => `${c.label ?? c.id} (${c.type ?? "text"})`).join(", ")}`
      : "(no custom columns)";

    const body = rows.map((r) => formatRow(r, customCols)).join("\n");
    sections.push(`### Board: ${board.name} — ${rows.length} contact${rows.length === 1 ? "" : "s"}\n${header}\n\n${body}`);
  }
  return sections.join("\n\n");
}

function formatRow(r: ContactRow, customCols: ColumnDef[]): string {
  const parts: string[] = [];
  parts.push(`- **${r.name}**`);
  if (r.title) parts.push(`title: ${r.title}`);
  if (r.company) parts.push(`company: ${r.company}`);
  if (r.email) parts.push(`email: ${r.email}`);
  if (r.linkedin) parts.push(`linkedin: ${r.linkedin}`);
  if (r.stage) parts.push(`stage: ${r.stage}`);
  // Custom field values, looked up by column id and labelled by user's
  // custom name. Skip empty cells. Truncate per-cell to 200 chars so a
  // bloated note field doesn't blow the token budget on one contact.
  const cf = r.custom_fields ?? {};
  for (const c of customCols) {
    const raw = cf[c.id];
    if (raw == null || raw === "") continue;
    const v = String(raw).slice(0, 200);
    parts.push(`${c.label ?? c.id}: ${v}`);
  }
  // Trim background + notes to keep token usage in check; the LLM still
  // gets enough to answer "what's interesting about X" questions.
  if (r.background) parts.push(`background: ${r.background.slice(0, 300)}`);
  if (r.notes) parts.push(`notes: ${r.notes.slice(0, 200)}`);
  return parts.join(" · ");
}
