/**
 * Per-BOARD Smartlead account: connect, load, and decrypt the stored API key.
 *
 * Each board carries its own Smartlead account, so two boards can send from
 * completely separate infrastructure — different domains, mailboxes, or even
 * different clients — with no shared credential between them. The webhook
 * token is per board as well, which is how an inbound event is attributed to
 * one board before its body is parsed.
 *
 * The API key is stored encrypted rather than passed per request (the pattern
 * used for Apollo/LLM keys) because the nightly reconciler and the webhook
 * handler run with no user request in flight and still need to call Smartlead.
 */
import { randomBytes } from "node:crypto";
import { db } from "../../db/index.js";
import { encryptSecret, decryptSecret } from "../crypto.js";

export interface OutreachAccount {
  id: string;
  userId: string;
  boardId: string;
  apiKey: string;
  webhookToken: string;
  webhookSecret: string;
  bounceThresholdPct: number;
}

interface AccountRow {
  id: string;
  user_id: string;
  board_id: string;
  api_key_encrypted: string;
  webhook_token: string;
  webhook_secret: string;
  bounce_threshold_pct: number;
}

function decodeRow(row: AccountRow): OutreachAccount {
  return {
    id: row.id,
    userId: row.user_id,
    boardId: row.board_id,
    apiKey: decryptSecret(row.api_key_encrypted),
    webhookToken: row.webhook_token,
    webhookSecret: row.webhook_secret,
    bounceThresholdPct: Number(row.bounce_threshold_pct ?? 2),
  };
}

export async function getAccountByBoard(boardId: string): Promise<OutreachAccount | null> {
  const row = await db
    .selectFrom("smartlead_accounts")
    .selectAll()
    .where("board_id", "=", boardId)
    .executeTakeFirst();
  return row ? decodeRow(row as AccountRow) : null;
}

/** Load an account by the token embedded in its webhook URL. */
export async function getAccountByWebhookToken(token: string): Promise<OutreachAccount | null> {
  const row = await db
    .selectFrom("smartlead_accounts")
    .selectAll()
    .where("webhook_token", "=", token)
    .executeTakeFirst();
  return row ? decodeRow(row as AccountRow) : null;
}

/** Every connected board for a user — used by the nightly reconciler. */
export async function listAccounts(): Promise<OutreachAccount[]> {
  const rows = await db.selectFrom("smartlead_accounts").selectAll().execute();
  return rows.map((r) => decodeRow(r as AccountRow));
}

/**
 * Connect (or re-key) a board's Smartlead account. Rotating the API key keeps
 * the existing webhook token/secret so the URL already configured in Smartlead
 * stays valid. Returns the webhook pair so the caller can show the user exactly
 * what to paste.
 */
export async function connectAccount(
  userId: string,
  boardId: string,
  apiKey: string,
): Promise<{ webhookToken: string; webhookSecret: string }> {
  const existing = await db
    .selectFrom("smartlead_accounts")
    .select(["webhook_token", "webhook_secret"])
    .where("board_id", "=", boardId)
    .executeTakeFirst();

  const webhookToken = existing?.webhook_token ?? randomBytes(24).toString("hex");
  const webhookSecret = existing?.webhook_secret ?? randomBytes(32).toString("hex");
  const api_key_encrypted = encryptSecret(apiKey);

  if (existing) {
    await db
      .updateTable("smartlead_accounts")
      .set({ api_key_encrypted, updated_at: new Date() as never })
      .where("board_id", "=", boardId)
      .execute();
  } else {
    await db
      .insertInto("smartlead_accounts")
      .values({
        user_id: userId, board_id: boardId, api_key_encrypted,
        webhook_token: webhookToken, webhook_secret: webhookSecret,
      })
      .execute();
  }
  return { webhookToken, webhookSecret };
}

/** Disconnect a board — removes its key and kills its webhook URL. */
export async function disconnectAccount(boardId: string): Promise<void> {
  await db.deleteFrom("smartlead_accounts").where("board_id", "=", boardId).execute();
}

/**
 * Rotate the webhook token + signing secret for one board. Invalidates the
 * previously configured URL, so the caller must show the new pair — this is
 * the only time the secret is returned.
 */
export async function rotateWebhook(boardId: string): Promise<{ webhookToken: string; webhookSecret: string }> {
  const webhookToken = randomBytes(24).toString("hex");
  const webhookSecret = randomBytes(32).toString("hex");
  await db
    .updateTable("smartlead_accounts")
    .set({ webhook_token: webhookToken, webhook_secret: webhookSecret, updated_at: new Date() as never })
    .where("board_id", "=", boardId)
    .execute();
  return { webhookToken, webhookSecret };
}

/** Bounce rate (%) at which this board raises an in-app alert. */
export async function setAlertConfig(boardId: string, cfg: { bounceThresholdPct?: number }): Promise<void> {
  if (cfg.bounceThresholdPct === undefined) return;
  await db
    .updateTable("smartlead_accounts")
    .set({ bounce_threshold_pct: cfg.bounceThresholdPct, updated_at: new Date() as never })
    .where("board_id", "=", boardId)
    .execute();
}
