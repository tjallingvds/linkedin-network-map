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
  completion_jobs: CompletionJobsTable;
  smartlead_accounts: SmartleadAccountsTable;
  outreach_campaigns: OutreachCampaignsTable;
  outreach_campaign_memberships: OutreachMembershipsTable;
  suppressions: SuppressionsTable;
  outreach_events: OutreachEventsTable;
  outreach_jobs: OutreachJobsTable;
  outreach_alerts: OutreachAlertsTable;
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
  /** Parent message in the chat tree. Null for a branch root (the first
   *  user message, or an edited sibling that re-roots the conversation).
   *  Drives edit-forking + retry-as-sibling + version navigation. */
  parent_id: string | null;
  created_at: Generated<Timestamp>;
}

export interface CrmBoardsTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  emoji: string;
  share_token: string | null;
  /** NOTE: no such column exists in the database — no migration ever added it.
   *  Kanban stages are held client-side (localStorage per board). Selecting
   *  this will fail at runtime; left declared only to avoid breaking existing
   *  references. Add a migration before relying on it. */
  stages: unknown | null;
  /** Shared table-column schema (order, widths, types, dropdown options,
   *  visibility, labels). JSONB. */
  columns: unknown | null;
  /** Shared row-height for the table view ("short"|"medium"|"tall"). */
  row_height: string | null;
  /** Outreach is off for every board until explicitly enabled. */
  outreach_enabled: Generated<boolean>;
  /** Stage ids + labels that mean "stop emailing": { noSend: string[] }. */
  outreach_stage_map: unknown | null;
  /** Board-specific instructions for writing opening lines. Null = default. */
  opening_prompt: string | null;
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
  /** ISO timestamp of the most recent touch (sent or received). Manual. */
  last_touch_at: Timestamp | null;
  /** Direction of the most recent touch — 'in' (we received) or 'out' (we sent). */
  last_touch_direction: string | null;
  /** Outreach content tier: 'A' | 'B' | 'C' | null (null = not in outreach). */
  tier: string | null;
  /** Personal first line, drafted from this contact's own context. */
  opening_line: string | null;
  /** Which facts it was built from — shown beside it during review. */
  opening_line_source: string | null;
  /** null | 'draft' | 'approved' | 'skipped'. */
  opening_line_status: string | null;
  opening_line_at: Timestamp | null;
  sector: string | null;
  /** Controlled outreach lifecycle, separate from the freeform kanban `stage`:
   *  null | 'queued' | 'contacted' | 'responded' | 'do_not_contact'. */
  outreach_status: string | null;
  outreach_status_at: Timestamp | null;
  next_step: string | null;
  /** Hard deadline tied to next_step ("send him the deck by Friday").
   *  Null when the user hasn't promised anything time-bound. */
  next_step_due_at: Timestamp | null;
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

/** Durable background-search jobs — survives a process restart so the client's
 *  poll still resolves after a Railway redeploy/OOM. See the 20260721 migration. */
export interface CompletionJobsTable {
  /** Caller-supplied job id (the route generates it, not the DB). */
  id: string;
  user_id: string;
  chat_id: string | null;
  /** 'running' | 'done' | 'error'. */
  status: Generated<string>;
  progress: string | null;
  /** Full CompletionPayload JSON once done; null while running / on error. */
  result: unknown | null;
  error: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/** Per-board Smartlead connection. api_key is stored encrypted; keys are needed
 *  by background jobs (reconciler, webhook handler) so header-only won't do. */
export interface SmartleadAccountsTable {
  id: Generated<string>;
  user_id: string;
  /** One Smartlead account per board — boards never share a key. */
  board_id: string;
  api_key_encrypted: string;
  webhook_token: string;
  webhook_secret: string;
  /** Bounce % at which a campaign raises an in-app alert. */
  bounce_threshold_pct: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface OutreachCampaignsTable {
  id: Generated<string>;
  user_id: string;
  board_id: string;
  provider_campaign_id: string;
  tier: string; // 'A' | 'B' | 'C'
  name: string | null;
  state: Generated<string>; // 'active' | 'paused' | 'completed'
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface OutreachMembershipsTable {
  id: Generated<string>;
  user_id: string;
  contact_id: string;
  campaign_id: string;
  provider_campaign_id: string;
  provider_lead_id: string | null;
  state: Generated<string>; // 'active' | 'paused' | 'completed' | 'blocked'
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface SuppressionsTable {
  id: Generated<string>;
  user_id: string;
  scope: string; // 'email' | 'domain'
  value: string;
  reason: string; // 'opt_out' | 'compliance' | 'bounce_hard' | 'manual'
  synced_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface OutreachEventsTable {
  id: Generated<string>;
  user_id: string | null;
  request_id: string | null;
  event_type: string;
  provider_campaign_id: string | null;
  provider_lead_id: string | null;
  to_email: string | null;
  contact_id: string | null;
  payload: unknown | null; // JSONB
  created_at: Generated<Timestamp>;
}

/** Durable background outreach jobs — exports (long-running pushes) and
 *  reconcile sweeps (whose timestamps drive the scheduler across restarts). */
export interface OutreachJobsTable {
  id: Generated<string>;
  user_id: string | null;
  kind: string; // 'export' | 'reconcile'
  status: Generated<string>; // 'running' | 'done' | 'error'
  progress: string | null;
  result: unknown | null; // JSONB
  error: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/** In-app deliverability notifications. Written by the nightly bounce check and
 *  by Smartlead's own threshold event; shown in the Outreach panel until read. */
export interface OutreachAlertsTable {
  id: Generated<string>;
  user_id: string;
  kind: string; // 'bounce_rate' | 'bounce_threshold' | 'live_leak' | 'reply_recovered'
  severity: Generated<string>; // 'warning' | 'critical'
  message: string;
  provider_campaign_id: string | null;
  read_at: Timestamp | null;
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
