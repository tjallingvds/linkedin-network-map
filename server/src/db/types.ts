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
  usage_events: UsageEventsTable;
  credit_purchases: CreditPurchasesTable;
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
  custom_fields: Generated<Record<string, unknown>>;
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
