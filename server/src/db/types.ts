import type { Generated, ColumnType } from "kysely";

/** Database schema types consumed by Kysely. */
export interface Database {
  users: UsersTable;
  accounts: AccountsTable; // OAuth links (Auth.js shape)
  sessions: SessionsTable; // Auth.js sessions
  verification_tokens: VerificationTokensTable;
  people: PeopleTable;
  chats: ChatsTable;
  messages: MessagesTable;
  crm_boards: CrmBoardsTable;
  crm_board_members: CrmBoardMembersTable;
  crm_contacts: CrmContactsTable;
  crm_attachments: CrmAttachmentsTable;
  usage_events: UsageEventsTable;
  credit_purchases: CreditPurchasesTable;
  message_log: MessageLogTable;
  sales_analysis_uploads: SalesUploadsTable;
  sales_analysis_connections: SalesConnectionsTable;
  sales_analysis_messages: SalesMessagesTable;
  sales_analysis_pinned: SalesPinnedAnalysesTable;
}

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  email_verified: Timestamp | null;
  name: string | null;
  image: string | null;
  password_hash: string | null; // null for OAuth-only users
  credit_balance: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface CreditPurchasesTable {
  id: Generated<string>;
  user_id: string;
  stripe_event_id: string;
  stripe_session_id: string | null;
  pack_id: string;
  credits_granted: number;
  amount_cents: number;
  currency: Generated<string>;
  created_at: Generated<Timestamp>;
}

export interface AccountsTable {
  id: Generated<string>;
  user_id: string;
  type: string; // 'oauth' | 'email' | 'credentials'
  provider: string; // 'google', etc.
  provider_account_id: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  token_type: string | null;
  scope: string | null;
  id_token: string | null;
  session_state: string | null;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  session_token: string;
  expires: Timestamp;
}

export interface VerificationTokensTable {
  identifier: string;
  token: string;
  expires: Timestamp;
}

export interface PeopleTable {
  id: Generated<string>;
  user_id: string;
  first_name: string;
  last_name: string;
  company: string | null;
  position: string | null;
  linkedin_url: string | null;
  email: string | null;
  phone: string | null;
  connected_on: string | null;
  category: string | null;
  industry: string | null;
  /** Distinguishes how the row landed in `people`. "invitation" rows are
   *  pending connection requests the user has sent; "connection" rows
   *  are actual 1st-degree connections. Null for legacy data. */
  kind: string | null;
  enrichment: unknown | null; // JSONB
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ChatsTable {
  id: Generated<string>;
  user_id: string;
  title: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface MessagesTable {
  id: Generated<string>;
  chat_id: string;
  role: string;
  content: string;
  /** Full CompletionResult JSON when the message represents a structured
   *  response (prospects / drafts). Null for plain-text messages. */
  result: unknown | null;
  created_at: Generated<Timestamp>;
}

export interface CrmBoardsTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  emoji: string;
  share_token: string | null;
  /** Shared kanban stage config for this board — null means "use client
   *  defaults". Persisted here (not in localStorage) so collaborators see
   *  the same stages the owner set up. JSONB. */
  stages: unknown | null;
  /** Shared table-column schema (order, widths, types, dropdown options,
   *  visibility, labels). JSONB. */
  columns: unknown | null;
  /** Shared row-height for the table view ("short"|"medium"|"tall"). */
  row_height: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface CrmBoardMembersTable {
  id: Generated<string>;
  board_id: string;
  user_id: string;
  created_at: Generated<Timestamp>;
}

export interface CrmContactsTable {
  id: Generated<string>;
  board_id: string;
  user_id: string;
  name: string;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  stage: Generated<string>;
  temp: Generated<string>;
  sent: Generated<number>;
  opens: Generated<number>;
  replies: Generated<number>;
  last_touch: string | null;
  next_step: string | null;
  source: string | null;
  notes: string | null;
  message_notes: string | null;
  background: string | null;
  custom_fields: Generated<Record<string, unknown>>;
  /** Notion-style long-form pages attached to this contact. JSONB. */
  documents: unknown | null;
  position_idx: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface UsageEventsTable {
  id: Generated<string>;
  user_id: string;
  provider: string;
  kind: string;
  input_tokens: Generated<number>;
  output_tokens: Generated<number>;
  credits: Generated<number>;
  cost_micros: Generated<number | bigint>;
  metadata: unknown | null;
  created_at: Generated<Timestamp>;
}

export interface MessageLogTable {
  id: Generated<string>;
  user_id: string;
  conversation_id: string | null;
  /** Other party's display name as it appeared in the CSV. */
  counterpart_name: string;
  /** Lowercase + non-alphanumeric stripped for matching. */
  counterpart_name_normalized: string;
  counterpart_linkedin_url: string | null;
  /** linkedin.com/in/ stripped, lowercased, trailing slash removed. */
  counterpart_linkedin_normalized: string | null;
  /** "sent" when the user authored the message; "received" otherwise. */
  direction: string;
  message_date: string | null;
  subject: string | null;
  content_snippet: string | null;
  created_at: Generated<Timestamp>;
}

export interface SalesUploadsTable {
  id: Generated<string>;
  user_id: string;
  team_member_name: string;
  detected_user_name: string | null;
  connections_count: Generated<number>;
  messages_count: Generated<number>;
  created_at: Generated<Timestamp>;
}

export interface SalesConnectionsTable {
  id: Generated<string>;
  user_id: string;
  upload_id: string;
  first_name: string;
  last_name: string;
  name_normalized: string;
  company: string | null;
  position: string | null;
  seniority: string | null;
  linkedin_url: string | null;
  linkedin_normalized: string | null;
  email: string | null;
  connected_on: string | null;
}

export interface SalesMessagesTable {
  id: Generated<string>;
  user_id: string;
  upload_id: string;
  conversation_id: string | null;
  counterpart_name: string;
  counterpart_name_normalized: string;
  counterpart_linkedin_url: string | null;
  counterpart_linkedin_normalized: string | null;
  direction: string;
  message_date: string | null;
  message_ts: Timestamp | null;
  subject: string | null;
  content_snippet: string | null;
  /** "cold" | "follow_up" | "reply" — computed at ingest time. */
  message_type: string | null;
  /** True when the original LinkedIn ATTACHMENTS column contained a video
   *  URL (LinkedIn-native, Loom, Vidyard, Vimeo, Wistia, YouTube) OR the
   *  message body mentions one. False (default) for older rows that were
   *  ingested before video tracking landed — re-upload to backfill. */
  has_video: Generated<boolean>;
}

export interface SalesPinnedAnalysesTable {
  id: Generated<string>;
  user_id: string;
  title: string;
  question: string | null;
  spec: unknown;
  position: Generated<number>;
  created_at: Generated<Timestamp>;
}

export interface CrmAttachmentsTable {
  /** Caller-supplied id (so the client can reference it before round-trip). */
  id: string;
  contact_id: string;
  filename: string;
  mime: string;
  size: number;
  /** PDF bytes etc — Buffer in Node, transferred as BYTEA. */
  data: Buffer;
  created_at: Generated<Timestamp>;
}
