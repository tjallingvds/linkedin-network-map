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

export type ChatMode = "find" | "enrich" | "draft";

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
  nextStep: string | null;
  source: string | null;
  notes: string | null;
  positionIdx: number;
  createdAt: string;
  updatedAt: string;
}

export interface CrmBoard {
  id: string;
  name: string;
  emoji: string;
  contactCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CrmImportRow {
  name: string;
  title?: string;
  company?: string;
  email?: string;
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
