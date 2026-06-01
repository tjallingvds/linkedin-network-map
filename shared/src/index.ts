// Domain types shared between client and server.
// Keep this file pure TypeScript — no runtime deps.

export type PersonCategory =
  | "founder_ceo"
  | "investor_vc"
  | "exec_leader"
  | "product_eng"
  | "sales_growth"
  | "ops_strategy"
  | "research_acad"
  | "other";

export type Industry =
  | "tech" | "finance" | "healthcare" | "consulting" | "media" | "retail"
  | "energy" | "realestate" | "education" | "government" | "nonprofit"
  | "manufacturing" | "other";

/** A single LinkedIn connection, as stored in the DB. */
export interface Person {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  company: string | null;
  position: string | null;
  linkedinUrl: string | null;
  email: string | null;
  phone: string | null;
  connectedOn: string | null;
  category: PersonCategory | null;
  industry: Industry | null;
  createdAt: string;
  updatedAt: string;
}

export type AiProvider = "openai" | "anthropic" | "deepseek";

// ---------- Chat ----------

export type ChatMode = "find" | "network" | "enrich" | "draft" | "followup" | "discover_more";

export type SignalKind = "hot" | "fresh" | "match";
export interface ProspectSignal {
  kind: SignalKind;
  text: string;
  when: string;
}
export interface PastRole {
  co: string;
  role: string;
  when: string;
}
/** A prospect returned from Find/Enrich. Optional fields reflect confidence
 *  — the AI may not always fill contact info. */
export interface Prospect {
  id: string;
  name: string;
  title: string;
  company: string;
  loc?: string;
  email?: string;
  emailConf?: number;
  phone?: string | null;
  linkedin?: string;
  headcount?: string;
  funding?: string;
  stack?: string[];
  signals: ProspectSignal[];
  past: PastRole[];
  matchPct: number;
}

export interface OutreachDraft {
  recipientId: string;
  recipientName: string;
  recipientCompany: string;
  email: { subject: string; body: string };
  linkedin: string;
}

/** The shape returned by POST /api/chats/:id/completion. */
export type CompletionResult =
  | { kind: "text"; content: string }
  | { kind: "prospects"; summary: string; prospects: Prospect[] }
  | { kind: "drafts"; drafts: OutreachDraft[] };

export interface ChatMessage {
  id: string;
  chatId: string;
  /** Parent message id in the chat tree, or null for a branch root. */
  parentId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface Chat {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

// ---------- CRM ----------

export type CrmStage = "new" | "contacted" | "replied" | "meeting" | "closed";
export type CrmTemp = "hot" | "warm" | "cold";

export interface CrmContact {
  id: string;
  boardId: string;
  name: string;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  stage: CrmStage;
  temp: CrmTemp;
  sent: number;
  opens: number;
  replies: number;
  lastTouch: string | null;
  /** ISO timestamp of the most recent touch. Manual — stamped by the
   *  "Sent" / "Received" buttons on the row. */
  lastTouchAt: string | null;
  /** Direction of the most recent touch — 'in' (received) or 'out' (sent). */
  lastTouchDirection: "in" | "out" | null;
  nextStep: string | null;
  /** Hard deadline tied to nextStep — ISO timestamp of the date the
   *  user promised to deliver ("send him the deck by Friday").
   *  Surfaces in the Overview "Deadlines" section with overdue +
   *  due-soon countdowns. Optional for back-compat with older
   *  clients that haven't deployed the schema bump. */
  nextStepDueAt?: string | null;
  source: string | null;
  notes: string | null;
  /** Free-form "what to personalize" hook for outreach. */
  messageNotes?: string | null;
  /** AI-generated background (recent posts / talks / interests) with
   *  inline source links. Populated by the "Find backgrounds" button. */
  background?: string | null;
  /** User-defined columns: map of column-id → cell value. Optional for
   *  backward compat with clients that haven't loaded the new schema. */
  customFields?: Record<string, string>;
  /** Notion-style long-form pages attached to this contact (meeting
   *  notes, briefs, proposals, …). Each entry has its own title + body;
   *  the drawer renders a Pages list with a focused editor view. */
  documents?: CrmDocument[];
  positionIdx: number;
  createdAt: string;
  updatedAt: string;
}

export interface CrmDocument {
  id: string;
  title: string;
  body: string;
  /** ISO timestamp of the last edit, used for sort + dirty checks. */
  updatedAt: string;
}

/** Lightweight handle to an uploaded file — what File-type cells store
 *  (JSON-stringified) so the UI can render filename + size without
 *  fetching the bytes until the user clicks. */
export interface CrmAttachmentMeta {
  id: string;
  filename: string;
  mime: string;
  size: number;
}

export interface CrmBoard {
  id: string;
  name: string;
  emoji: string;
  contactCount?: number;
  /** true when the current user owns this board. */
  owned?: boolean;
  /** true when the board was joined via a share token (read-write member). */
  shared?: boolean;
  /** Whether a share token currently exists (owner only). */
  hasShareToken?: boolean;
  /** Per-board kanban stages, shared across all collaborators. Null means
   *  client uses DEFAULT_STAGES. Stored on the board so a stage added by
   *  the owner is visible to shared-with users without each configuring
   *  their own copy. */
  stages?: CrmStageDef[] | null;
  /** Per-board table-column schema (order, widths, types, dropdown options,
   *  visibility, labels). Shared across collaborators. Null means the
   *  client falls back to its built-in defaults. */
  columns?: CrmColumnDef[] | null;
  /** Row height for the table view. Shared across collaborators. */
  rowHeight?: CrmRowHeight | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrmStageDef {
  id: string;
  label: string;
  color: string;
  tint: string;
}

export type CrmColumnType =
  | "text"
  | "longtext"
  | "number"
  | "dropdown"
  | "email"
  | "phone"
  | "link"
  | "date"
  | "checkbox"
  /** Each cell links to its own per-row Notion-style page. The cell
   *  stores the document id; the document body lives on the contact's
   *  `documents` JSONB array. */
  | "page"
  /** Each cell stores an uploaded file (PDF / image / anything). The
   *  cell value is JSON.stringify({id, filename, mime, size}) — bytes
   *  are streamed via /api/crm/attachments/:id. */
  | "file"
  | "stage"
  | "temp"
  | "person"
  /** Manual "last message" tracking — timestamp + direction (in/out).
   *  Stamped by one-click buttons in the cell. Powers follow-up
   *  staleness signals and the Companies group rollup. */
  | "touch"
  | "select"; // internal: row-select checkbox

/** Row height in pixels. Min 28, max 200. The legacy enum values map to:
 *  short = 32, medium = 44, tall = 60. */
export type CrmRowHeight = number;

export interface CrmDropdownOption {
  value: string;
  color?: string;
}

/** One column on a CRM board's table view. Both built-in (`builtin: true`,
 *  data lives in core contact fields) and user-defined (`builtin: false`,
 *  data lives in `customFields[id]`) columns share this shape so the
 *  renderer doesn't need a special case per kind. */
export interface CrmColumnDef {
  id: string;
  /** True for built-in columns whose data lives on a real contact field
   *  (name/title/email/...). False for user-added columns whose data lives
   *  inside `customFields[id]`. */
  builtin: boolean;
  label: string;
  type: CrmColumnType;
  /** CSS grid-template-columns size token. */
  width?: string;
  hidden?: boolean;
  /** Required when `type === "dropdown"`. */
  options?: CrmDropdownOption[];
}

export interface CrmImportRow {
  name: string;
  title?: string;
  company?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  notes?: string;
  stage?: string;
  temp?: string;
  source?: string;
  nextStep?: string;
}

// ---------- Auth ----------

export interface UserPublic {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

export interface SessionResponse {
  user: UserPublic | null;
}
