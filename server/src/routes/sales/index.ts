/**
 * Sales analysis routes.
 *
 *   POST   /api/sales/uploads           ingest a paired connections+messages
 *                                       CSV pair for one team member
 *   GET    /api/sales/uploads           list uploads (with counts)
 *   DELETE /api/sales/uploads/:id       delete one upload (cascades rows)
 *   GET    /api/sales/analytics         computed metrics across all uploads
 *   POST   /api/sales/chat              one-shot LLM call scoped to the
 *                                       analytics dataset; returns answer +
 *                                       optional chart spec
 *   GET    /api/sales/pinned            list pinned custom analyses
 *   POST   /api/sales/pinned            pin a chart spec
 *   DELETE /api/sales/pinned/:id        unpin
 */
import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { db } from "../../db/index.js";
import type { AuthedRequest } from "../../auth/session.js";
import {
  normalizeCounterpartName,
  normalizeCounterpartLinkedIn,
} from "../../ai/messaged-set.js";
import { extractUserKeys } from "../../ai/user-keys.js";
import { aiJson, isLlmAuthError, isLlmQuotaError } from "../../ai/json.js";
import { availableProviders } from "../../ai/providers.js";
import type { AiProvider } from "@app/shared";
import { classifyTitle, SENIORITY_LABEL, SENIORITY_ORDER, type SeniorityBucket } from "./seniority.js";

const router = Router();

// -------------------- helpers --------------------

function parseLinkedInDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // LinkedIn formats: "2024-04-12 13:45:00 UTC", ISO, or "Apr 12, 2024".
  const cleaned = trimmed.replace(/\sUTC$/i, "Z").replace(" ", "T");
  const t = Date.parse(cleaned);
  if (!Number.isNaN(t)) return new Date(t);
  const t2 = Date.parse(trimmed);
  return Number.isNaN(t2) ? null : new Date(t2);
}

/** Classify each sent message into cold / follow_up / reply by walking each
 *  conversation in order. The first sent message in a conversation with no
 *  prior received is "cold"; a sent message after only prior sent messages is
 *  "follow_up"; a sent message after at least one received message is "reply".
 *  Received messages are tagged "received" but never enter the type chart. */
function computeMessageTypes<T extends {
  conversation_id: string | null;
  counterpart_name_normalized: string;
  direction: string;
  message_ts: Date | null;
  message_date: string | null;
}>(messages: T[]): (T & { message_type: string })[] {
  // Group by (conversation_id || counterpartName) so we still get useful
  // grouping when LinkedIn omitted the conversation id.
  const groupKey = (m: T) =>
    m.conversation_id && m.conversation_id.length > 0
      ? `c:${m.conversation_id}`
      : `n:${m.counterpart_name_normalized}`;

  const groups = new Map<string, T[]>();
  for (const m of messages) {
    const k = groupKey(m);
    const arr = groups.get(k);
    if (arr) arr.push(m);
    else groups.set(k, [m]);
  }

  const tsOf = (m: T): number => {
    if (m.message_ts instanceof Date) return m.message_ts.getTime();
    const t = parseLinkedInDate(m.message_date);
    return t ? t.getTime() : 0;
  };

  const out: (T & { message_type: string })[] = [];
  for (const [, arr] of groups) {
    arr.sort((a, b) => tsOf(a) - tsOf(b));
    let receivedSeen = false;
    let sentSeen = false;
    for (const m of arr) {
      let type: string;
      if (m.direction === "received") {
        type = "received";
        receivedSeen = true;
      } else if (receivedSeen) {
        type = "reply";
      } else if (sentSeen) {
        type = "follow_up";
      } else {
        type = "cold";
      }
      if (m.direction === "sent") sentSeen = true;
      out.push({ ...m, message_type: type });
    }
  }
  return out;
}

// -------------------- uploads --------------------

const connectionInput = z.object({
  firstName: z.string().min(1).max(200),
  lastName: z.string().min(1).max(200),
  company: z.string().max(500).nullish(),
  position: z.string().max(500).nullish(),
  linkedinUrl: z.string().max(500).nullish(),
  email: z.string().max(200).nullish(),
  connectedOn: z.string().max(64).nullish(),
});

const messageInput = z.object({
  conversationId: z.string().max(200).nullish(),
  counterpartName: z.string().min(1).max(200),
  counterpartLinkedinUrl: z.string().max(500).nullish(),
  direction: z.enum(["sent", "received"]),
  messageDate: z.string().max(64).nullish(),
  subject: z.string().max(500).nullish(),
  contentSnippet: z.string().max(4000).nullish(),
  /** Set by the parser when ATTACHMENTS contained a LinkedIn-native video,
   *  a third-party video URL, or the body mentioned a video. Older clients
   *  that don't send this default to false. */
  hasVideo: z.boolean().optional(),
});

const uploadSchema = z.object({
  teamMemberName: z.string().min(1).max(200),
  detectedUserName: z.string().max(200).nullish(),
  connections: z.array(connectionInput).max(50_000),
  messages: z.array(messageInput).max(100_000),
});

router.post("/uploads", async (req: AuthedRequest, res) => {
  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
  }
  const userId = req.user!.id;
  const { teamMemberName, detectedUserName, connections, messages } = parsed.data;

  const upload = await db
    .insertInto("sales_analysis_uploads")
    .values({
      user_id: userId,
      team_member_name: teamMemberName,
      detected_user_name: detectedUserName ?? null,
      connections_count: connections.length,
      messages_count: messages.length,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();

  // Ingest connections in batches of 500.
  for (let i = 0; i < connections.length; i += 500) {
    const batch = connections.slice(i, i + 500);
    await db
      .insertInto("sales_analysis_connections")
      .values(
        batch.map((c) => ({
          user_id: userId,
          upload_id: upload.id,
          first_name: c.firstName,
          last_name: c.lastName,
          name_normalized: normalizeCounterpartName(`${c.firstName} ${c.lastName}`),
          company: c.company ?? null,
          position: c.position ?? null,
          seniority: classifyTitle(c.position ?? null),
          linkedin_url: c.linkedinUrl ?? null,
          linkedin_normalized: c.linkedinUrl ? normalizeCounterpartLinkedIn(c.linkedinUrl) : null,
          email: c.email ?? null,
          connected_on: c.connectedOn ?? null,
        })),
      )
      .execute();
  }

  // Compute message_type at ingest by sorting per conversation.
  const annotated = computeMessageTypes(
    messages.map((m) => ({
      conversation_id: m.conversationId ?? null,
      counterpart_name_normalized: normalizeCounterpartName(m.counterpartName),
      direction: m.direction,
      message_ts: parseLinkedInDate(m.messageDate ?? null),
      message_date: m.messageDate ?? null,
      _orig: m,
    })),
  );

  for (let i = 0; i < annotated.length; i += 500) {
    const batch = annotated.slice(i, i + 500);
    await db
      .insertInto("sales_analysis_messages")
      .values(
        batch.map((m) => ({
          user_id: userId,
          upload_id: upload.id,
          conversation_id: m._orig.conversationId ?? null,
          counterpart_name: m._orig.counterpartName,
          counterpart_name_normalized: m.counterpart_name_normalized,
          counterpart_linkedin_url: m._orig.counterpartLinkedinUrl ?? null,
          counterpart_linkedin_normalized: m._orig.counterpartLinkedinUrl
            ? normalizeCounterpartLinkedIn(m._orig.counterpartLinkedinUrl)
            : null,
          direction: m._orig.direction,
          message_date: m._orig.messageDate ?? null,
          message_ts: m.message_ts,
          subject: m._orig.subject ?? null,
          content_snippet: m._orig.contentSnippet ?? null,
          message_type: m.message_type,
          has_video: m._orig.hasVideo ?? false,
        })),
      )
      .execute();
  }

  res.json({ id: upload.id, connectionsInserted: connections.length, messagesInserted: messages.length });
});

router.get("/uploads", async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const rows = await db
    .selectFrom("sales_analysis_uploads")
    .select([
      "id",
      "team_member_name",
      "detected_user_name",
      "connections_count",
      "messages_count",
      sql<string>`created_at::text`.as("created_at"),
    ])
    .where("user_id", "=", userId)
    .orderBy("created_at", "desc")
    .execute();
  res.json({ uploads: rows });
});

router.delete("/uploads/:id", async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  await db
    .deleteFrom("sales_analysis_uploads")
    .where("user_id", "=", userId)
    .where("id", "=", req.params.id)
    .execute();
  res.json({ ok: true });
});

// -------------------- analytics --------------------

interface AnalyticsRow {
  totals: {
    uploads: number;
    connections: number;
    messages: number;
    sent: number;
    received: number;
    cold: number;
    followUp: number;
    reply: number;
    uniqueCounterparts: number;
  };
  responseRate: {
    overall: number;
    cold: number;
    followUp: number;
  };
  byTeamMember: {
    uploadId: string;
    teamMember: string;
    sent: number;
    received: number;
    cold: number;
    followUp: number;
    responseRate: number;
  }[];
  bySeniority: { bucket: SeniorityBucket; label: string; sent: number; replies: number; responseRate: number }[];
  byMessageType: { type: string; count: number }[];
  byMonth: { month: string; sent: number; received: number }[];
}

router.get("/analytics", async (req: AuthedRequest, res) => {
  const userId = req.user!.id;

  const uploads = await db
    .selectFrom("sales_analysis_uploads")
    .select(["id", "team_member_name"])
    .where("user_id", "=", userId)
    .execute();

  if (uploads.length === 0) {
    return res.json({
      totals: { uploads: 0, connections: 0, messages: 0, sent: 0, received: 0, cold: 0, followUp: 0, reply: 0, uniqueCounterparts: 0 },
      responseRate: { overall: 0, cold: 0, followUp: 0 },
      byTeamMember: [],
      bySeniority: [],
      byMessageType: [],
      byMonth: [],
    } satisfies AnalyticsRow);
  }

  const totals = await db
    .selectFrom("sales_analysis_messages")
    .select((eb) => [
      eb.fn.count<number>("id").as("messages"),
      eb.fn.count<number>("id").filterWhere("direction", "=", "sent").as("sent"),
      eb.fn.count<number>("id").filterWhere("direction", "=", "received").as("received"),
      eb.fn.count<number>("id").filterWhere("message_type", "=", "cold").as("cold"),
      eb.fn.count<number>("id").filterWhere("message_type", "=", "follow_up").as("followUp"),
      eb.fn.count<number>("id").filterWhere("message_type", "=", "reply").as("reply"),
      sql<number>`count(distinct counterpart_name_normalized)`.as("uniqueCounterparts"),
    ])
    .where("user_id", "=", userId)
    .executeTakeFirst();

  const connectionsCount = await db
    .selectFrom("sales_analysis_connections")
    .select((eb) => eb.fn.count<number>("id").as("c"))
    .where("user_id", "=", userId)
    .executeTakeFirst();

  // Response rate = % of sent counterparts (cold or follow_up) that ever
  // produced any received reply. We compute per team member then aggregate.
  const perUploadStats = await db
    .selectFrom("sales_analysis_messages")
    .select([
      "upload_id",
      sql<number>`count(*) filter (where direction = 'sent')`.as("sent"),
      sql<number>`count(*) filter (where direction = 'received')`.as("received"),
      sql<number>`count(*) filter (where message_type = 'cold')`.as("cold"),
      sql<number>`count(*) filter (where message_type = 'follow_up')`.as("followUp"),
      sql<number>`count(distinct counterpart_name_normalized) filter (where direction = 'sent')`.as("sentTo"),
      sql<number>`count(distinct counterpart_name_normalized) filter (where direction = 'sent' and counterpart_name_normalized in (select counterpart_name_normalized from sales_analysis_messages sm2 where sm2.upload_id = sales_analysis_messages.upload_id and sm2.direction = 'received'))`.as("respondedBy"),
    ])
    .where("user_id", "=", userId)
    .groupBy("upload_id")
    .execute();

  const teamLookup = new Map(uploads.map((u) => [u.id, u.team_member_name]));
  const byTeamMember = perUploadStats
    .map((s) => ({
      uploadId: s.upload_id,
      teamMember: teamLookup.get(s.upload_id) ?? "—",
      sent: Number(s.sent),
      received: Number(s.received),
      cold: Number(s.cold),
      followUp: Number(s.followUp),
      responseRate: Number(s.sentTo) > 0 ? Number(s.respondedBy) / Number(s.sentTo) : 0,
    }))
    .sort((a, b) => b.sent - a.sent);

  // Overall response rate across the whole workspace.
  const overall = await db
    .selectFrom("sales_analysis_messages")
    .select([
      sql<number>`count(distinct counterpart_name_normalized) filter (where direction = 'sent')`.as("sentTo"),
      sql<number>`count(distinct counterpart_name_normalized) filter (where direction = 'sent' and counterpart_name_normalized in (select counterpart_name_normalized from sales_analysis_messages sm2 where sm2.user_id = sales_analysis_messages.user_id and sm2.upload_id = sales_analysis_messages.upload_id and sm2.direction = 'received'))`.as("respondedBy"),
      sql<number>`count(distinct counterpart_name_normalized) filter (where message_type = 'cold')`.as("coldTo"),
      sql<number>`count(distinct counterpart_name_normalized) filter (where message_type = 'cold' and counterpart_name_normalized in (select counterpart_name_normalized from sales_analysis_messages sm2 where sm2.user_id = sales_analysis_messages.user_id and sm2.upload_id = sales_analysis_messages.upload_id and sm2.direction = 'received'))`.as("coldResponded"),
      sql<number>`count(distinct counterpart_name_normalized) filter (where message_type = 'follow_up')`.as("followUpTo"),
      sql<number>`count(distinct counterpart_name_normalized) filter (where message_type = 'follow_up' and counterpart_name_normalized in (select counterpart_name_normalized from sales_analysis_messages sm2 where sm2.user_id = sales_analysis_messages.user_id and sm2.upload_id = sales_analysis_messages.upload_id and sm2.direction = 'received'))`.as("followUpResponded"),
    ])
    .where("user_id", "=", userId)
    .executeTakeFirst();

  // Seniority breakdown — join messages to connections by upload_id +
  // normalized name. A connection's seniority drives the bucket. If no match,
  // bucket = "unknown".
  const seniorityRaw = await db
    .selectFrom("sales_analysis_messages as m")
    .leftJoin("sales_analysis_connections as c", (join) =>
      join
        .onRef("c.upload_id", "=", "m.upload_id")
        .onRef("c.name_normalized", "=", "m.counterpart_name_normalized"),
    )
    .select([
      sql<string>`coalesce(c.seniority, 'unknown')`.as("bucket"),
      sql<number>`count(distinct m.counterpart_name_normalized) filter (where m.direction = 'sent')`.as("sentTo"),
      sql<number>`count(distinct m.counterpart_name_normalized) filter (where m.direction = 'sent' and m.counterpart_name_normalized in (select counterpart_name_normalized from sales_analysis_messages sm2 where sm2.upload_id = m.upload_id and sm2.direction = 'received'))`.as("respondedBy"),
    ])
    .where("m.user_id", "=", userId)
    .groupBy(sql`coalesce(c.seniority, 'unknown')`)
    .execute();

  const bySeniority = seniorityRaw
    .map((r) => {
      const bucket = (r.bucket as SeniorityBucket) ?? "unknown";
      const sent = Number(r.sentTo);
      const replies = Number(r.respondedBy);
      return {
        bucket,
        label: SENIORITY_LABEL[bucket] ?? bucket,
        sent,
        replies,
        responseRate: sent > 0 ? replies / sent : 0,
      };
    })
    .sort((a, b) => SENIORITY_ORDER.indexOf(a.bucket) - SENIORITY_ORDER.indexOf(b.bucket));

  const typeCounts = await db
    .selectFrom("sales_analysis_messages")
    .select([
      sql<string>`coalesce(message_type, 'unknown')`.as("type"),
      sql<number>`count(*)`.as("count"),
    ])
    .where("user_id", "=", userId)
    .groupBy(sql`coalesce(message_type, 'unknown')`)
    .execute();

  const byMessageType = typeCounts.map((r) => ({ type: r.type, count: Number(r.count) }));

  const monthly = await db
    .selectFrom("sales_analysis_messages")
    .select([
      sql<string>`to_char(date_trunc('month', message_ts), 'YYYY-MM')`.as("month"),
      sql<number>`count(*) filter (where direction = 'sent')`.as("sent"),
      sql<number>`count(*) filter (where direction = 'received')`.as("received"),
    ])
    .where("user_id", "=", userId)
    .where("message_ts", "is not", null)
    .groupBy(sql`date_trunc('month', message_ts)`)
    .orderBy(sql`date_trunc('month', message_ts)`, "asc")
    .execute();

  const byMonth = monthly.map((r) => ({
    month: r.month,
    sent: Number(r.sent),
    received: Number(r.received),
  }));

  const sentTo = Number(overall?.sentTo ?? 0);
  const respondedBy = Number(overall?.respondedBy ?? 0);
  const coldTo = Number(overall?.coldTo ?? 0);
  const coldResp = Number(overall?.coldResponded ?? 0);
  const fuTo = Number(overall?.followUpTo ?? 0);
  const fuResp = Number(overall?.followUpResponded ?? 0);

  const payload: AnalyticsRow = {
    totals: {
      uploads: uploads.length,
      connections: Number(connectionsCount?.c ?? 0),
      messages: Number(totals?.messages ?? 0),
      sent: Number(totals?.sent ?? 0),
      received: Number(totals?.received ?? 0),
      cold: Number(totals?.cold ?? 0),
      followUp: Number(totals?.followUp ?? 0),
      reply: Number(totals?.reply ?? 0),
      uniqueCounterparts: Number(totals?.uniqueCounterparts ?? 0),
    },
    responseRate: {
      overall: sentTo > 0 ? respondedBy / sentTo : 0,
      cold: coldTo > 0 ? coldResp / coldTo : 0,
      followUp: fuTo > 0 ? fuResp / fuTo : 0,
    },
    byTeamMember,
    bySeniority,
    byMessageType,
    byMonth,
  };

  res.json(payload);
});

// -------------------- chat --------------------

const chatSchema = z.object({
  question: z.string().min(1).max(50_000),
  /** Optional: prior turns so the assistant can follow up coherently. */
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(50_000) }))
    .max(20)
    .optional(),
});

/** Hard cap on how many message rows the chat LLM sees inline. Token cost is
 *  ~80 tokens per row at 100-char snippets, so 12k rows ≈ 1M tokens worst
 *  case. Claude / GPT-4-class models handle this comfortably; user has opted
 *  in to "spend whatever it takes". Beyond this we stratified-sample. */
const CHAT_ROW_BUDGET = 12000;

router.post("/chat", async (req: AuthedRequest, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });

  const userKeys = extractUserKeys(req);
  // Prefer Anthropic when available — large context window keeps full row
  // dumps cheap; fall back to whatever the user has configured.
  const order: AiProvider[] = ["anthropic", "openai", "deepseek"];
  const available = availableProviders(userKeys);
  const provider: AiProvider =
    order.find((p) => available.includes(p)) ?? available[0] ?? ("openai" as AiProvider);

  const userId = req.user!.id;

  // Pull every message + the counterpart's connection metadata (seniority,
  // position, company, name) so the LLM can filter on any of these.
  const rowsRaw = await db
    .selectFrom("sales_analysis_messages as m")
    .leftJoin("sales_analysis_connections as c", (join) =>
      join
        .onRef("c.upload_id", "=", "m.upload_id")
        .onRef("c.name_normalized", "=", "m.counterpart_name_normalized"),
    )
    .leftJoin("sales_analysis_uploads as u", "u.id", "m.upload_id")
    .select([
      "u.team_member_name as teamMember",
      "m.counterpart_name as counterpart",
      "m.direction",
      "m.message_type as messageType",
      sql<string>`coalesce(c.seniority, 'unknown')`.as("seniority"),
      "c.position",
      "c.company",
      "m.message_date as messageDate",
      "m.subject",
      "m.content_snippet as snippet",
      "m.conversation_id as conversationId",
    ])
    .where("m.user_id", "=", userId)
    .orderBy("m.message_ts", "desc")
    .limit(CHAT_ROW_BUDGET)
    .execute();

  // Compact each row to keep prompt size predictable. We keep the full
  // subject / position / company / counterpart so the LLM can filter and
  // cite specifics; snippet is trimmed since the substance is usually in
  // the first sentence.
  const rowsBase = rowsRaw.map((r) => ({
    teamMember: r.teamMember ?? "—",
    counterpart: r.counterpart,
    direction: r.direction,
    type: r.messageType ?? "unknown", // per-conversation type from ingest
    seniority: r.seniority ?? "unknown",
    position: r.position ?? null,
    company: r.company ?? null,
    date: r.messageDate ?? null,
    subject: r.subject ?? null,
    snippet: (r.snippet ?? "").slice(0, 200) || null,
    convId: r.conversationId ?? null,
  }));

  // Override the per-conversation type with a stricter per-counterpart
  // classification. The first sent message to a given counterpart (across
  // ALL conversations, ordered by date) is "cold". Any later sent message
  // with no received in between is "follow_up". Sent after at least one
  // received is "reply". This matches what the user means by "first
  // message" — LinkedIn often opens a new conversation_id for the same
  // counterpart, which used to inflate the cold count.
  const groups = new Map<string, typeof rowsBase>();
  for (const r of rowsBase) {
    const k = `${r.teamMember}|${r.counterpart}`;
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }
  const tsOf = (s: string | null): number => {
    if (!s) return 0;
    const cleaned = s.replace(/\sUTC$/i, "Z").replace(" ", "T");
    const t = Date.parse(cleaned);
    return Number.isNaN(t) ? 0 : t;
  };
  const idToType = new Map<typeof rowsBase[number], string>();
  for (const arr of groups.values()) {
    arr.sort((a, b) => tsOf(a.date) - tsOf(b.date));
    let receivedSeen = false;
    let sentSeen = false;
    for (const r of arr) {
      let type: string;
      if (r.direction === "received") {
        type = "received";
        receivedSeen = true;
      } else if (receivedSeen) {
        type = "reply";
      } else if (sentSeen) {
        type = "follow_up";
      } else {
        type = "cold";
      }
      if (r.direction === "sent") sentSeen = true;
      idToType.set(r, type);
    }
  }
  const rows = rowsBase.map((r) => ({ ...r, type: idToType.get(r) ?? r.type }));

  // Pre-compute aggregates so simple totals don't require the LLM to
  // count rows. The LLM gets BOTH — aggregates for fast lookups, rows
  // for any filtered or detailed question.
  const responders = new Set<string>();
  for (const r of rows) {
    if (r.direction === "received") responders.add(`${r.teamMember}|${r.counterpart}`);
  }
  type Bucket = { sent: number; received: number; coldSent: number; counterparts: Set<string>; responded: Set<string> };
  const fresh = (): Bucket => ({ sent: 0, received: 0, coldSent: 0, counterparts: new Set(), responded: new Set() });
  const byTeam = new Map<string, Bucket>();
  const bySen = new Map<string, Bucket>();
  const byType = new Map<string, number>();

  for (const r of rows) {
    const tm = r.teamMember;
    if (!byTeam.has(tm)) byTeam.set(tm, fresh());
    if (!bySen.has(r.seniority)) bySen.set(r.seniority, fresh());
    const T = byTeam.get(tm)!;
    const S = bySen.get(r.seniority)!;
    if (r.direction === "sent") {
      T.sent += 1; T.counterparts.add(r.counterpart);
      S.sent += 1; S.counterparts.add(r.counterpart);
      if (r.type === "cold") T.coldSent += 1;
      const k = `${tm}|${r.counterpart}`;
      if (responders.has(k)) { T.responded.add(r.counterpart); S.responded.add(r.counterpart); }
    } else {
      T.received += 1; S.received += 1;
    }
    byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
  }

  const aggregates = {
    totals: {
      rowsInDataset: rows.length,
      sent: rows.filter((r) => r.direction === "sent").length,
      received: rows.filter((r) => r.direction === "received").length,
    },
    byTeamMember: Array.from(byTeam.entries()).map(([name, v]) => ({
      teamMember: name,
      sent: v.sent, received: v.received, coldSent: v.coldSent,
      uniqueCounterparts: v.counterparts.size,
      uniqueResponded: v.responded.size,
      responseRate: v.counterparts.size > 0 ? +(v.responded.size / v.counterparts.size).toFixed(3) : 0,
    })),
    bySeniority: Array.from(bySen.entries()).map(([bucket, v]) => ({
      seniority: bucket,
      label: SENIORITY_LABEL[bucket as SeniorityBucket] ?? bucket,
      sent: v.sent,
      uniqueCounterparts: v.counterparts.size,
      uniqueResponded: v.responded.size,
      responseRate: v.counterparts.size > 0 ? +(v.responded.size / v.counterparts.size).toFixed(3) : 0,
    })),
    byMessageType: Array.from(byType.entries()).map(([type, count]) => ({ type, count })),
  };

  const SYSTEM = `You are an in-app sales analytics analyst. You have FULL ACCESS to the user's data, attached below as JSON. You MUST do the analysis yourself. You MUST NOT:
- Suggest the user run the analysis somewhere else.
- Suggest they paste the data into another tool (ChatGPT, Gemini, Excel, etc.).
- Refuse, hedge, or ask them to upload anything.
- Tell them the dataset is "too complex" — it isn't, it's right here in your context.
- Output a "prompt to use elsewhere". You are the tool.

The data is below. Compute over it. Answer the question. Even if the question is a multi-step brief, work through it and produce the result.

You will receive:
  AGGREGATES — pre-computed totals and breakdowns by team member, seniority, message type.
  ROWS — every message in the dataset (up to 12k), joined with the counterpart's seniority / position / company / subject / snippet / conversation_id / date. Filter, group, and count over ROWS to answer ANY question the AGGREGATES don't cover.

Use ROWS for:
- Filtered questions ("response rate for messages mentioning 'pricing'", "directors at AI companies", "Sarah's cold messages to founders").
- Multi-step analyses (clustering by template, follow-up cadences, success classification, etc.). Do every step inline.
- Counting unique people, not just rows. Group by counterpart name.
- Pulling example subjects/snippets to illustrate a point.

Use AGGREGATES for top-line totals and quick breakdowns.

INTERPRETING "MESSAGE TYPE" / "WHAT WORKS BEST":
The 'type' field on a row only carries one signal: cold vs follow_up vs reply. That is rarely what the user means when they ask "what message type works best", "what variant", "which cold message works", or similar. They almost always mean the CONTENT of the messages — different templates / wordings / personalization levels. So when the user asks "what message type works for X":
1. Filter ROWS to the right scope (e.g. cold first messages to bank people in the last month).
2. Cluster the SUBJECTS + SNIPPETS by similarity. Treat near-duplicate phrasings (only name/company swapped) as one template cluster. Treat highly personalized one-offs as their own cluster or call them out individually.
3. Compute response rate per cluster × seniority bucket. Show the cluster's distinctive opener (first 8–12 words) so the user can identify it.
4. Use the 'type' field only as a filter ("among cold messages, which template…") — never as the answer to "which message type works".

If the user asks specifically about cold/follow_up/reply, use the type field directly. If they say "which cold message" / "which template" / "which variant" / "what wording", cluster by content as above.

Rules:
- Compute from the data. Never invent numbers.
- A "response" = that counterpart appears with direction='received' for the same teamMember at any point. Don't require time ordering.
- Response rate = (unique counterparts who replied) / (unique counterparts messaged). Always unique-people.
- The 'type' field is computed PER COUNTERPART (not per LinkedIn conversation_id). 'cold' = the very first message ever sent to that counterpart by that team member, across all conversations. 'follow_up' = a later sent message to the same counterpart with no received in between. 'reply' = sent after at least one received. When the user says "first messages only", filter to type='cold'. Do NOT include type='follow_up' rows in a "first messages only" analysis.
- Be specific. Cite numbers, names, percentages. Don't be vague.
- When the user asks for a chart, return one in the chart field. For open questions, return a chart if it sharpens the answer.
- For long multi-step briefs: work through every step. Use markdown headings (##), tables, bullet lists in the answer field — they will render. Don't truncate. Don't punt to "the user should run this elsewhere".

CHARTS — IMPORTANT:
- Output charts as an ARRAY (one or more) in the "charts" field. NEVER return an empty array when the analysis includes comparison tables or numerical breakdowns where a chart would aid scanning. If the answer has 5 breakdown tables, you should typically produce 3–5 charts (the comparisons that matter most).
- "kind": "bar" for category × value comparisons, "pie" only when showing parts of a whole, "line" for time series, "number" for a single headline metric.
- Don't bother charting anything where n < 30 across categories — flag that in the answer instead.
- Each chart must have a clear title and a meaningful "metric" label (e.g. "Success rate (%)").

INLINE PLACEMENT — IMPORTANT:
- Place each chart inline next to the table or paragraph it belongs to. Insert the literal placeholder \`[[CHART:N]]\` on its own line at the position you want the chart to render, where N is the 0-based index in the "charts" array. Example: a 3-chart answer might have \`[[CHART:0]]\` after the personalization table, \`[[CHART:1]]\` after the seniority breakdown, \`[[CHART:2]]\` in the conclusion.
- Every chart in the array MUST have exactly one matching \`[[CHART:N]]\` marker in the answer. Don't dump charts at the end. Don't reference a chart with prose — use the marker.
- The marker is the only way charts render inline. Without it the chart is hidden.

Output STRICTLY this JSON shape (no other prose, no code fences):
{
  "answer": "<full analysis as markdown — multi-section with tables, bullets, and [[CHART:N]] markers placed inline>",
  "charts": [
    {
      "kind": "bar" | "pie" | "line" | "number",
      "title": "<short title>",
      "metric": "<what is plotted>",
      "data": [{ "label": "<x>", "value": <number> }]
    }
  ],
  "suggestedTitle": "<short label if pinned, ≤60 chars>"
}`;

  const USER = `AGGREGATES:
${JSON.stringify(aggregates)}

ROWS (${rows.length}):
${JSON.stringify(rows)}

PRIOR TURNS (most recent last):
${(parsed.data.history ?? []).map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n") || "(none)"}

QUESTION:
${parsed.data.question}`;

  try {
    const result = await aiJson<{
      answer: string;
      charts?: Array<{
        kind: "bar" | "pie" | "line" | "number";
        title: string;
        metric: string;
        data: { label: string; value: number }[];
      }>;
      // Legacy single-chart shape — older runs may still emit it. Fold into
      // `charts` so the client only has to handle one shape.
      chart?: null | {
        kind: "bar" | "pie" | "line" | "number";
        title: string;
        metric: string;
        data: { label: string; value: number }[];
      };
      suggestedTitle: string;
    }>(provider, SYSTEM, USER, { maxTokens: 16000, userId, userKeys });
    const charts = result.charts ?? (result.chart ? [result.chart] : []);
    res.json({
      answer: result.answer ?? "",
      charts,
      suggestedTitle: result.suggestedTitle ?? "",
    });
  } catch (e) {
    if (isLlmAuthError(e)) return res.status(401).json({ error: "llm_auth", message: (e as Error).message });
    if (isLlmQuotaError(e)) return res.status(402).json({ error: "llm_quota", message: (e as Error).message });
    return res.status(500).json({ error: "llm_error", message: (e as Error).message });
  }
});

// -------------------- audit (replaces chat) --------------------

const auditSchema = z.object({
  industry: z.string().min(1).max(500),
  goal: z.string().max(1000).nullish(),
});

router.post("/audit", async (req: AuthedRequest, res) => {
  const parsed = auditSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });

  const userKeys = extractUserKeys(req);
  const order: AiProvider[] = ["anthropic", "openai", "deepseek"];
  const available = availableProviders(userKeys);
  const provider: AiProvider =
    order.find((p) => available.includes(p)) ?? available[0] ?? ("openai" as AiProvider);

  const userId = req.user!.id;

  // Pull every message + connection metadata (same query as chat) but use the
  // NORMALIZED counterpart name as the grouping key — names with stray
  // whitespace or accent variations were ending up in different groups,
  // which inflated the cold count.
  const rowsRaw = await db
    .selectFrom("sales_analysis_messages as m")
    .leftJoin("sales_analysis_connections as c", (join) =>
      join
        .onRef("c.upload_id", "=", "m.upload_id")
        .onRef("c.name_normalized", "=", "m.counterpart_name_normalized"),
    )
    .leftJoin("sales_analysis_uploads as u", "u.id", "m.upload_id")
    .select([
      "u.team_member_name as teamMember",
      "m.counterpart_name as counterpart",
      "m.counterpart_name_normalized as counterpartNameKey",
      "m.counterpart_linkedin_normalized as counterpartUrlKey",
      "m.direction",
      sql<string>`coalesce(c.seniority, 'unknown')`.as("seniority"),
      "c.position",
      "c.company",
      "m.message_date as messageDate",
      "m.message_ts as messageTs",
      "m.subject",
      "m.content_snippet as snippet",
      "m.conversation_id as conversationId",
      "m.has_video as hasVideo",
    ])
    .where("m.user_id", "=", userId)
    // Newest-first so if the dataset is bigger than CHAT_ROW_BUDGET we keep
    // the recent campaigns the user actually cares about. Per-counterpart
    // re-classification below sorts each bucket by date again, so the type
    // assignment is unaffected by the SQL order.
    .orderBy("m.message_ts", "desc")
    .limit(CHAT_ROW_BUDGET)
    .execute();

  /** Best-effort timestamp. Prefer the indexed message_ts column the ingest
   *  computed; fall back to parsing message_date; -1 means unknown. We use
   *  -1 rather than 0 so unknown rows sort to the end of the asc walk
   *  (otherwise a row with no date would steal the "cold" slot from a real
   *  first message). */
  const tsOf = (tsCol: Date | string | null | undefined, dateCol: string | null | undefined): number => {
    if (tsCol instanceof Date) return tsCol.getTime();
    if (typeof tsCol === "string") {
      const t = Date.parse(tsCol);
      if (!Number.isNaN(t)) return t;
    }
    if (dateCol) {
      const cleaned = dateCol.replace(/\sUTC$/i, "Z").replace(" ", "T");
      const t = Date.parse(cleaned);
      if (!Number.isNaN(t)) return t;
    }
    return -1;
  };

  /** Strip trailing credential / suffix tokens that change between messages
   *  ("Allison Nathan" vs "Allison Nathan, CFA, MD"). Keeps every name token,
   *  just drops the credentials, so compound surnames like "van der Schaar"
   *  survive intact. */
  const STRIP = /\b(ph\.?\s*d\.?|phd|cfa|cpa|m\.?d\.?|md|mba|m\.?sc|msc|mphil|m\.?b\.?b\.?s\.?|mbbs|esq|jr|sr|ii|iii|iv)\b/gi;
  const cleanName = (name: string): string =>
    name.replace(STRIP, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

  /** Group key for cold/follow_up classification. Uses ONLY the cleaned
   *  name — the LinkedIn URL is missing on many received messages (LinkedIn
   *  doesn't always export SENDER PROFILE URL), which used to put a sent
   *  + the counterpart's reply into separate buckets and made the second
   *  sent look like a follow_up when it was really a reply. */
  const groupKeyFor = (r: typeof rowsRaw[number]): string =>
    `${r.teamMember}|${cleanName(r.counterpartNameKey ?? "")}`;

  // Group by (teamMember, stable counterpart key) so the same human is one
  // bucket even when their displayed name shifts across messages or they add
  // credentials. groupKeyFor prefers the LinkedIn URL when present.
  type RawRow = typeof rowsRaw[number];
  const buckets = new Map<string, RawRow[]>();
  for (const r of rowsRaw) {
    const k = groupKeyFor(r);
    const arr = buckets.get(k);
    if (arr) arr.push(r);
    else buckets.set(k, [r]);
  }

  // For every row: compute the per-counterpart-global type, the
  // sent-message-number-in-conversation (1 = cold, 2 = first follow-up, …),
  // the days since the previous sent message, and a simple has-video flag.
  // Match explicit video signals. Platforms (loom, vidyard, vimeo, wistia,
  // youtube/youtu.be) plus common phrases. Stays loose enough to catch
  // "I made a quick walkthrough" and "screencast attached" but not so loose
  // that "demo" or "watch" alone trigger it (those have too many false
  // positives in sales messages).
  const VIDEO_RE =
    /(\bloom\.com\b|\bloom\b|\bvidyard\b|\bvimeo\b|\bwistia\b|\byoutu\.?be\b|\byoutube\b|\bvideo\b|\bvideos\b|\bvids?\b|\bwalkthrough\b|\bscreencast\b|\b(?:recorded|made|sent|attached|here'?s)\s+(?:a\s+)?(?:quick\s+)?(?:short\s+)?(?:little\s+)?(?:video|clip|loom|walkthrough|screencast))/i;
  type Annotated = {
    teamMember: string;
    counterpart: string;
    counterpartKey: string;
    direction: string;
    type: "cold" | "follow_up" | "reply" | "received" | "unknown";
    sentNo: number | null;        // 1-indexed across this counterpart's SENT messages
    daysSincePrevSent: number | null;
    seniority: string;
    position: string | null;
    company: string | null;
    date: string | null;
    subject: string | null;
    snippet: string | null;
    hasVideo: boolean;
    /** True if the counterpart ever replied to this team member. */
    counterpartReplied: boolean;
  };
  const annotated: Annotated[] = [];

  for (const arr of buckets.values()) {
    // Stable sort by best-effort timestamp. Rows whose date can't be parsed
    // get ts = -1 and sort to the FRONT only if they're at -1 — but we
    // explicitly defer those to the END below so they can never claim the
    // "cold" slot from a real first message.
    arr.sort((a, b) => {
      const ta = tsOf(a.messageTs as Date | null, a.messageDate ?? null);
      const tb = tsOf(b.messageTs as Date | null, b.messageDate ?? null);
      // Push undated (-1) to the end of the asc walk:
      const ka = ta < 0 ? Number.MAX_SAFE_INTEGER : ta;
      const kb = tb < 0 ? Number.MAX_SAFE_INTEGER : tb;
      return ka - kb;
    });
    const counterpartReplied = arr.some((r) => r.direction === "received");
    let receivedSeen = false;
    let sentSeen = false;
    let sentNo = 0;
    let prevSentTs: number | null = null;
    for (const r of arr) {
      const ts = tsOf(r.messageTs as Date | null, r.messageDate ?? null);
      const dated = ts >= 0;
      let type: Annotated["type"];
      if (!dated) {
        // Without a timestamp we can't tell where this falls in the thread.
        // Mark it 'unknown' rather than risk labeling an undated row 'cold'
        // and inflating the cold bucket.
        type = "unknown";
      } else if (r.direction === "received") {
        type = "received";
        receivedSeen = true;
      } else if (receivedSeen) {
        type = "reply";
      } else if (sentSeen) {
        type = "follow_up";
      } else {
        type = "cold";
      }
      let myNo: number | null = null;
      let gap: number | null = null;
      if (r.direction === "sent" && dated) {
        sentNo += 1;
        myNo = sentNo;
        if (prevSentTs != null && ts > 0) gap = +(((ts - prevSentTs) / 86_400_000).toFixed(1));
        prevSentTs = ts;
        sentSeen = true;
      }
      // Prefer the DB flag (set at ingest from ATTACHMENTS / hosted-video URLs
      // / body text); fall back to a body-text regex for older rows that
      // were imported before video tracking landed.
      const haystack = `${r.subject ?? ""} ${r.snippet ?? ""}`;
      const hasVideo = r.hasVideo === true || VIDEO_RE.test(haystack);
      annotated.push({
        teamMember: r.teamMember ?? "—",
        counterpart: r.counterpart,
        counterpartKey: r.counterpartNameKey ?? "",
        direction: r.direction,
        type,
        sentNo: myNo,
        daysSincePrevSent: gap,
        seniority: r.seniority ?? "unknown",
        position: r.position ?? null,
        company: r.company ?? null,
        date: r.messageDate ?? null,
        subject: r.subject ?? null,
        // Keep the full snippet (DB stores up to 1000 chars from the new
        // upload flow). Truncation was masking late-paragraph differences
        // that distinguish templates, so the LLM was lumping semantic
        // siblings into one cluster.
        snippet: r.snippet ?? null,
        hasVideo,
        counterpartReplied,
      });
    }
  }

  // Stable per-row ID so the LLM can reference rows by ID instead of
  // restating their content. The server then resolves IDs back to full
  // rows for deterministic stats — no number is ever hallucinated.
  const sentRows = annotated.filter((r) => r.direction === "sent");
  const rowsById = new Map<string, Annotated>();
  const promptRows = sentRows.map((r, i) => {
    const id = `r${i}`;
    rowsById.set(id, r);
    return {
      id,
      tm: r.teamMember,
      cp: r.counterpart,
      ty: r.type,
      no: r.sentNo,
      sn: r.seniority,
      pos: r.position,
      co: r.company,
      d: r.date,
      sub: r.subject,
      sn_text: r.snippet,
      vid: r.hasVideo,
    };
  });

  // Build per-counterpart thread bundles so the LLM can judge thread
  // outcomes (success / no-success) by reading the received messages.
  // threadKey matches what the cluster stats below use for joining.
  const receivedByThread = new Map<string, Annotated[]>();
  for (const r of annotated) {
    if (r.direction !== "received") continue;
    const k = `${r.teamMember}|${r.counterpartKey}`;
    const arr = receivedByThread.get(k);
    if (arr) arr.push(r);
    else receivedByThread.set(k, [r]);
  }
  // Only emit threads where the user actually sent something — no point
  // asking the LLM to judge threads with zero outbound from us.
  const threadKeysWithSent = new Set(sentRows.map((r) => `${r.teamMember}|${r.counterpartKey}`));
  const promptThreads = Array.from(threadKeysWithSent).map((k) => {
    const replies = (receivedByThread.get(k) ?? [])
      .slice(0, 6) // 6 received snippets is plenty to judge tone
      .map((r) => r.snippet ?? "")
      .filter((s) => s.length > 0);
    return { threadKey: k, replies };
  });

  const SYSTEM = `You are a sales-quality auditor. Your ONLY job is filtering and clustering — the server computes every stat deterministically. Do NOT return counts, percentages, rates, averages, or any number except a sample row id.

INPUT YOU GET
- ROWS: every SENT message (cold + follow_up). Each row has an id (r0, r1, …) you'll reference back, plus team member, counterpart, type, sent-number, seniority, position, company, date, subject, snippet, video flag.
- INDUSTRY: filter by the RECIPIENT'S industry. The user audits outreach SENT TO people in this industry. The message body / subject is IRRELEVANT for inclusion — only the recipient's company and position matter.

  INCLUDE a row when ANY of these are clearly true:
    - recipient.company is a firm in the industry. For "banking" / "financial services": Wells Fargo, JPMorgan / JPMorgan Chase, Goldman Sachs, Morgan Stanley, UBS, HSBC, Citi / Citigroup, Barclays, Deutsche Bank, Bank of America, BNY Mellon, BNP Paribas, ING, Rabobank, Lazard, BlackRock, Bridgewater, Two Sigma, Citadel, Renaissance, generic "X Bank" / "X Financial" / "X Capital", credit unions, asset managers, hedge funds, wealth managers, private equity, insurance giants, etc.
    - recipient.position mentions an industry term: "banker", "investment banking", "credit risk", "trading", "wealth management", "fixed income", "asset management", "private equity", "head of AI in banking", "CIO at a bank", etc.

  EXCLUDE a row when:
    - recipient.company / position is in a different industry (ed-tech, biotech, recruiting, design, healthcare, climate, etc.). The message body / sender's pitch is irrelevant — even if the user's template mentions "banking", a recipient in ed-tech is OUT OF SCOPE.
    - recipient.company AND recipient.position are both null/missing AND the recipient name doesn't clearly belong to a known industry firm. Without evidence the recipient is in the industry, drop the row. Be willing to drop most of the dataset to keep the audit focused.

  IGNORE the message body / subject when deciding inclusion. Their only job is to inform clustering AFTER the filter has run.

- GOAL: optional context for clustering and success-classification. Doesn't affect industry inclusion.
- Some rows have type='unknown' — that means the timestamp was missing so we can't tell whether they were a cold or a follow-up. Treat them as their own category; do NOT include them as cold first messages.

YOUR JOB
1. Pick the row IDs that match the INDUSTRY filter (recipient is in the industry per their company/position). Put them in filteredRowIds.

2. Cluster the FILTERED COLD messages (ty='cold') by message content. Aim for HIGH granularity but DON'T invent clusters that have no rows.

   Two messages are the SAME cluster ONLY when their bodies are near-verbatim duplicates with only the following swapped:
     - recipient first name / last name / company name / job title.
   Anything else makes them different clusters. Examples of DIFFERENT clusters even when 80% the same:
     - One has an extra sentence the other doesn't.
     - The paragraphs are in a different order.
     - A different opening hook ("Loved your post on X" vs "Saw your interview about X" vs "Just read your piece on X").
     - A different CTA wording ("would love to chat" vs "would love your perspective" vs "open to a 30-min call?").
     - A different P.S. / signoff / value-prop sentence.
     - Different mention of the team member's credential (DeepMind Scholar vs Imperial researcher vs Schmidt Futures).
     - One adds a referral or social proof line the other lacks.

   HARD RULES:
   - Every cluster you return MUST have at least 1 rowId from filteredRowIds. NEVER emit a cluster with an empty rowIds array. NEVER emit a cluster as "the user might have sent this someday" — only clusters that actually exist in the data.
   - Singleton clusters (one rowId) are fine ONLY when the message is genuinely a one-off that doesn't fit any other cluster. Don't split a 5-message template into 5 singletons just because of small wording tweaks.
   - When in doubt, MERGE small variants into a parent cluster rather than splitting hairs. The user wants to spot real templates, not analyse every word.
   - Aim for ~5-15 clusters total, not 30+. Quality over granularity.

3. Cluster the FILTERED FOLLOW-UP messages (ty='follow_up') the same way (ids "fug-1", "fug-2", …). Same hard rules — no empty clusters, ~5-15 total.
4. Read the THREADS array (one per recipient-of-our-outreach with up to 6 of their reply snippets) and decide which threads ended in real success. Put those thread keys in successfulThreadKeys. SUCCESS is strictly:
     - The recipient agreed to a call / proposed a time / accepted a meeting, OR
     - A substantive multi-turn back-and-forth on the topic (questions, info shared, real engagement — not just acknowledgements).
   NOT success:
     - "Thanks, I'll take a look" / "Got it" / "Will check" — polite acknowledgements.
     - "Not for us right now" / "Too busy" — declines.
     - Single emoji / one-liner.
     - Out-of-office or autoresponses.
     - Generic interest with no commitment ("sounds interesting").
   Be strict. Better to under-count success than to overstate.
5. Write 4–7 short topInsights as plain text. NO numbers — describe patterns the server will quantify (e.g. "Cluster fmg-3 was concentrated on C-level recipients.").

DO NOT return: counts, percentages, reply rates, success rates, average follow-ups, mean days, sender splits, per-seniority breakdowns, video impact, or anything numeric per cluster. The server computes ALL of those from the IDs and keys you return.

Output STRICTLY this JSON shape (no other prose, no fences):
{
  "filteredRowIds": ["r12", "r35", ...],
  "coldClusters": [
    {
      "id": "fmg-1",
      "label": "<short human label>",
      "sampleId": "<one row id from this cluster>",
      "rowIds": ["r12", "r35", ...]
    }
  ],
  "followUpClusters": [
    {
      "id": "fug-1",
      "label": "<short>",
      "sampleId": "<row id>",
      "rowIds": ["r48", ...]
    }
  ],
  "successfulThreadKeys": ["Tjalling|allison nathan", "Fatimah|eric hahn", ...],
  "topInsights": ["<short text only — no fabricated numbers>", "..."]
}

Constraints:
- Every rowId in any cluster's rowIds MUST also appear in filteredRowIds.
- Every cluster's sampleId MUST be in its own rowIds.
- A row should appear in at most one cluster (cold OR follow-up, never both — the type is fixed).
- Don't include any rows whose recipient isn't in the industry, even if the body sounds relevant.
- Thread keys in successfulThreadKeys must come from the THREADS list — they're "<teamMember>|<normalized counterpart name>" exactly as given.
- A thread that has no reply at all is NEVER a success.`;

  const USER = `INDUSTRY: ${parsed.data.industry}
GOAL: ${parsed.data.goal ?? ""}

ROWS (${promptRows.length} sent rows):
${JSON.stringify(promptRows)}

THREADS (${promptThreads.length} threads with ≥1 sent message — judge success from the replies):
${JSON.stringify(promptThreads)}`;

  type LlmCluster = { id: string; label: string; sampleId: string; rowIds: string[] };
  type LlmResponse = {
    filteredRowIds: string[];
    coldClusters: LlmCluster[];
    followUpClusters: LlmCluster[];
    successfulThreadKeys?: string[];
    topInsights: string[];
  };

  let llm: LlmResponse;
  try {
    llm = await aiJson<LlmResponse>(provider, SYSTEM, USER, { maxTokens: 16000, userId, userKeys });
  } catch (e) {
    if (isLlmAuthError(e)) return res.status(401).json({ error: "llm_auth", message: (e as Error).message });
    if (isLlmQuotaError(e)) return res.status(402).json({ error: "llm_quota", message: (e as Error).message });
    return res.status(500).json({ error: "llm_error", message: (e as Error).message });
  }

  // ---- DETERMINISTIC STATS PASS ----
  // From here on, every number is server-computed. We resolve LLM-returned
  // row IDs back to full row objects (dropping any unknown IDs) and walk the
  // data ourselves.

  const validId = (id: string) => rowsById.has(id);
  const filteredIds = new Set((llm.filteredRowIds ?? []).filter(validId));
  const filteredRows = Array.from(filteredIds).map((id) => rowsById.get(id)!);

  // Build a per-counterpart index across the FILTERED scope so we can
  // compute per-cluster follow-up counts and time-to-first-followup.
  // Counterparts in the filtered scope still have access to all their
  // sent messages (filtered or not) for follow-up counting; using the
  // original annotated array is fine because cold rows live there too.
  const counterpartFollowUps = new Map<string, Annotated[]>();
  const counterpartCold = new Map<string, Annotated>();
  for (const r of annotated) {
    if (r.direction !== "sent") continue;
    const k = `${r.teamMember}|${r.counterpartKey}`;
    if (r.type === "cold" && !counterpartCold.has(k)) counterpartCold.set(k, r);
    if (r.type === "follow_up") {
      const arr = counterpartFollowUps.get(k);
      if (arr) arr.push(r);
      else counterpartFollowUps.set(k, [r]);
    }
  }

  /** % of unique counterparts in this set who ever replied. */
  const replyRate = (rows: Annotated[]): number => {
    const cps = new Set(rows.map((r) => `${r.teamMember}|${r.counterpartKey}`));
    if (cps.size === 0) return 0;
    const replied = new Set(rows.filter((r) => r.counterpartReplied).map((r) => `${r.teamMember}|${r.counterpartKey}`));
    return +(replied.size / cps.size).toFixed(3);
  };

  // The LLM has already classified every thread as success / not-success
  // by reading the actual reply text. Any thread key it didn't list is a
  // non-success. Use this set to score clusters.
  const successThreads = new Set(llm.successfulThreadKeys ?? []);
  /** % of unique counterparts in this set whose thread the LLM marked as a
   *  real success (booked call / substantive multi-turn engagement). */
  const successRate = (rows: Annotated[]): number => {
    const cps = new Set(rows.map((r) => `${r.teamMember}|${r.counterpartKey}`));
    if (cps.size === 0) return 0;
    let successes = 0;
    for (const k of cps) if (successThreads.has(k)) successes += 1;
    return +(successes / cps.size).toFixed(3);
  };

  const senderSplit = (rows: Annotated[]): { name: string; count: number }[] => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.teamMember, (m.get(r.teamMember) ?? 0) + 1);
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  };

  const senioritySplit = (rows: Annotated[]): { bucket: string; n: number; successRate: number }[] => {
    const m = new Map<string, Annotated[]>();
    for (const r of rows) {
      const arr = m.get(r.seniority);
      if (arr) arr.push(r);
      else m.set(r.seniority, [r]);
    }
    return Array.from(m.entries())
      .map(([bucket, arr]) => ({ bucket, n: arr.length, successRate: successRate(arr) }))
      .sort((a, b) => b.n - a.n);
  };

  const buildColdGroup = (cluster: LlmCluster) => {
    const rows = cluster.rowIds.filter(validId).map((id) => rowsById.get(id)!).filter((r) => r.type === "cold");
    const cps = new Set(rows.map((r) => `${r.teamMember}|${r.counterpartKey}`));
    // Avg follow-ups after this cold opener: count how many follow-ups were
    // sent to each counterpart in this cluster.
    const followCounts: number[] = [];
    const firstGapDays: number[] = [];
    for (const k of cps) {
      const fus = counterpartFollowUps.get(k) ?? [];
      followCounts.push(fus.length);
      if (fus.length > 0 && fus[0]?.daysSincePrevSent != null) firstGapDays.push(fus[0].daysSincePrevSent);
    }
    const avgFollowupsAfter =
      followCounts.length > 0 ? +(followCounts.reduce((a, b) => a + b, 0) / followCounts.length).toFixed(2) : 0;
    const meanDaysToFirstFollowup =
      firstGapDays.length > 0 ? +(firstGapDays.reduce((a, b) => a + b, 0) / firstGapDays.length).toFixed(1) : null;
    const sample = rowsById.get(cluster.sampleId);
    return {
      id: cluster.id,
      label: cluster.label,
      sampleSnippet: sample?.snippet ?? rows[0]?.snippet ?? "",
      count: rows.length,
      uniqueRecipients: cps.size,
      senderSplit: senderSplit(rows),
      metrics: {
        replyRate: replyRate(rows),
        successRate: successRate(rows),
        avgFollowupsAfter,
        meanDaysToFirstFollowup,
      },
      bySeniority: senioritySplit(rows),
    };
  };

  const buildFollowUpGroup = (cluster: LlmCluster) => {
    const rows = cluster.rowIds.filter(validId).map((id) => rowsById.get(id)!).filter((r) => r.type === "follow_up");
    const cps = new Set(rows.map((r) => `${r.teamMember}|${r.counterpartKey}`));
    // Most-common sent number in this cluster (2 = first follow-up, …).
    const numCounts = new Map<number, number>();
    const gaps: number[] = [];
    for (const r of rows) {
      if (r.sentNo != null) numCounts.set(r.sentNo, (numCounts.get(r.sentNo) ?? 0) + 1);
      if (r.daysSincePrevSent != null) gaps.push(r.daysSincePrevSent);
    }
    const typicalSentNumber = numCounts.size > 0
      ? Array.from(numCounts.entries()).sort((a, b) => b[1] - a[1])[0]![0]
      : 0;
    const meanDaysSincePrev =
      gaps.length > 0 ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : null;
    const sample = rowsById.get(cluster.sampleId);
    return {
      id: cluster.id,
      label: cluster.label,
      sampleSnippet: sample?.snippet ?? rows[0]?.snippet ?? "",
      count: rows.length,
      uniqueRecipients: cps.size,
      senderSplit: senderSplit(rows),
      metrics: {
        replyRate: replyRate(rows),
        successRate: successRate(rows),
        typicalSentNumber,
        meanDaysSincePrev,
      },
      bySeniority: senioritySplit(rows),
    };
  };

  // Drop clusters that resolved to zero rows (LLM speculated, no actual
  // matches landed). For the rest: keep clusters with count >= MIN_VISIBLE
  // as their own card; fold the long tail of n=1/n=2 variants into a
  // single synthetic "Other variants" cluster so the dashboard isn't a
  // 30-card avalanche while no data is lost — the user can still see
  // total count, sender split, and a sample.
  const MIN_VISIBLE = 3;

  /** Fold clusters with count < MIN_VISIBLE into a single Other-variants
   *  cluster while keeping the rest as-is. The Other cluster's sample is
   *  the longest snippet across the long-tail rows so the user gets a
   *  representative read. */
  const foldLongTail = <T extends ReturnType<typeof buildColdGroup> | ReturnType<typeof buildFollowUpGroup>>(
    groups: T[],
    kind: "cold" | "follow_up",
  ): T[] => {
    const big = groups.filter((g) => g.count >= MIN_VISIBLE);
    const small = groups.filter((g) => g.count > 0 && g.count < MIN_VISIBLE);
    if (small.length <= 1) {
      return [...big, ...small].sort((a, b) => b.count - a.count) as T[];
    }
    // Combine the underlying rows. We can't refer to the original cluster
    // rowIds here, but we can rebuild a synthetic group from each cluster's
    // already-computed metrics. To keep counts and senderSplits accurate,
    // re-aggregate from the row IDs the LLM gave us.
    const allRowIds: string[] = [];
    const variantLabels: string[] = [];
    for (const g of small) {
      variantLabels.push(g.label);
      // Look up the original LLM cluster to get its rowIds — they're stored
      // by id in the source arrays.
      const orig =
        kind === "cold"
          ? (llm.coldClusters ?? []).find((c) => c.id === g.id)
          : (llm.followUpClusters ?? []).find((c) => c.id === g.id);
      if (orig) allRowIds.push(...orig.rowIds);
    }
    const builder = kind === "cold" ? buildColdGroup : buildFollowUpGroup;
    const synthetic = builder({
      id: kind === "cold" ? "fmg-other" : "fug-other",
      label: `Other variants (${small.length})`,
      sampleId: allRowIds[0] ?? "",
      rowIds: allRowIds,
    }) as T;
    // Surface the constituent labels so the user can tell what's in the
    // long tail at a glance.
    (synthetic as unknown as { variantLabels: string[] }).variantLabels = variantLabels;
    return [...big, synthetic].sort((a, b) => b.count - a.count) as T[];
  };

  const firstMessageGroupsRaw = (llm.coldClusters ?? [])
    .map(buildColdGroup)
    .filter((g) => g.count > 0);
  const followUpGroupsRaw = (llm.followUpClusters ?? [])
    .map(buildFollowUpGroup)
    .filter((g) => g.count > 0);
  const firstMessageGroups = foldLongTail(firstMessageGroupsRaw, "cold");
  const followUpGroups = foldLongTail(followUpGroupsRaw, "follow_up");

  // Best cluster per seniority — require n >= MIN_BEST_N so a single 100%
  // win on n=1 doesn't crowd out a 50%-on-n=12 winner. Ties broken on n.
  const MIN_BEST_N = 3;
  const SENIORITY_LABELS: Record<string, string> = {
    c_level: "C-Level", founder: "Founder", head: "Head", director: "Director",
    vp: "VP", partner: "Partner", principal: "Principal", senior_manager: "Senior Manager",
    manager: "Manager", lead: "Lead", senior_ic: "Senior IC", ic: "IC",
    junior: "Junior", intern: "Intern", student: "Student", advisor: "Advisor",
    unknown: "Unknown",
  };
  const seniorityBuckets = new Map<string, true>();
  for (const g of firstMessageGroups) {
    for (const s of g.bySeniority) seniorityBuckets.set(s.bucket, true);
  }
  const bySeniority: Array<{ bucket: string; label: string; bestGroupId: string; bestGroupLabel: string; successRate: number; n: number }> = [];
  for (const [bucket] of seniorityBuckets) {
    let best: { groupId: string; groupLabel: string; rate: number; n: number } | null = null;
    for (const g of firstMessageGroups) {
      const s = g.bySeniority.find((x) => x.bucket === bucket);
      if (!s || s.n < MIN_BEST_N) continue;
      if (
        !best ||
        s.successRate > best.rate ||
        (s.successRate === best.rate && s.n > best.n)
      ) {
        best = { groupId: g.id, groupLabel: g.label, rate: s.successRate, n: s.n };
      }
    }
    if (best) {
      bySeniority.push({
        bucket,
        label: SENIORITY_LABELS[bucket] ?? bucket,
        bestGroupId: best.groupId,
        bestGroupLabel: best.groupLabel,
        successRate: best.rate,
        n: best.n,
      });
    }
  }
  bySeniority.sort((a, b) => b.n - a.n || b.successRate - a.successRate);

  // Video impact — scoped to the FILTERED rows only (used to be over the
  // entire dataset, which is why the user saw 113 vs 2330 even on a banking
  // filter).
  const videoImpact = (() => {
    const buckets: Record<number, { n: number; nWithVideo: number; replied: number; repliedWithVideo: number }> = {};
    let withVideoN = 0, withVideoReplied = 0, withoutN = 0, withoutReplied = 0;
    for (const r of filteredRows) {
      const k = r.sentNo ?? 0;
      buckets[k] ??= { n: 0, nWithVideo: 0, replied: 0, repliedWithVideo: 0 };
      buckets[k].n += 1;
      if (r.hasVideo) {
        buckets[k].nWithVideo += 1;
        withVideoN += 1;
        if (r.counterpartReplied) { buckets[k].repliedWithVideo += 1; withVideoReplied += 1; }
      } else {
        withoutN += 1;
        if (r.counterpartReplied) withoutReplied += 1;
      }
      if (r.counterpartReplied) buckets[k].replied += 1;
    }
    const byMessageNumber = Object.entries(buckets)
      .filter(([n]) => Number(n) > 0 && Number(n) <= 6)
      .map(([n, v]) => ({
        messageNumber: Number(n),
        n: v.n,
        withVideo: v.nWithVideo,
        replyRateWithVideo: v.nWithVideo > 0 ? +(v.repliedWithVideo / v.nWithVideo).toFixed(3) : 0,
        replyRateOverall: v.n > 0 ? +(v.replied / v.n).toFixed(3) : 0,
      }))
      .sort((a, b) => a.messageNumber - b.messageNumber);
    // Auto-recommendation. Plain math, no LLM — keeps the audit honest.
    const overallWith = withVideoN > 0 ? withVideoReplied / withVideoN : 0;
    const overallWithout = withoutN > 0 ? withoutReplied / withoutN : 0;
    const lift = overallWithout > 0 ? overallWith / overallWithout : 0;
    let recommendation = "";
    if (withVideoN === 0) {
      recommendation = "No videos sent to this audience yet. Worth testing on follow-ups (#2 onward) to see if it lifts replies.";
    } else if (withVideoN < 10) {
      recommendation = `Only ${withVideoN} video message(s) in this audience — sample is too small to call. Send more to get a real read.`;
    } else if (lift >= 1.2) {
      recommendation = `Video-attached messages reply at ${(overallWith * 100).toFixed(1)}% vs ${(overallWithout * 100).toFixed(1)}% without — about ${lift.toFixed(1)}× lift on n=${withVideoN}. Worth doubling down.`;
    } else if (lift <= 0.85) {
      recommendation = `Video-attached messages reply at ${(overallWith * 100).toFixed(1)}% vs ${(overallWithout * 100).toFixed(1)}% without — under-performing on n=${withVideoN}. Likely selection bias (videos go to harder targets); test by sending video on a randomized first-touch.`;
    } else {
      recommendation = `Video and text-only have similar reply rates (${(overallWith * 100).toFixed(1)}% vs ${(overallWithout * 100).toFixed(1)}%). On n=${withVideoN} video sends — keep using where it feels right, no clear lift either way.`;
    }
    return {
      overall: {
        withVideo: { n: withVideoN, replyRate: withVideoN > 0 ? +(withVideoReplied / withVideoN).toFixed(3) : 0 },
        without:   { n: withoutN, replyRate: withoutN > 0 ? +(withoutReplied / withoutN).toFixed(3) : 0 },
      },
      byMessageNumber,
      recommendation,
    };
  })();

  const totalCold = filteredRows.filter((r) => r.type === "cold").length;
  const totalFollowUps = filteredRows.filter((r) => r.type === "follow_up").length;

  res.json({
    scope: {
      industry: parsed.data.industry,
      goal: parsed.data.goal ?? "",
      totalMatched: filteredRows.length,
      totalCold,
      totalFollowUps,
    },
    firstMessageGroups,
    followUpGroups,
    bySeniority,
    videoImpact,
    topInsights: (llm.topInsights ?? []).slice(0, 8),
  });
});

// -------------------- pinned analyses --------------------

const pinSchema = z.object({
  title: z.string().min(1).max(120),
  question: z.string().max(2000).nullish(),
  spec: z.object({
    kind: z.enum(["bar", "pie", "line", "number"]),
    metric: z.string().max(200),
    data: z.array(z.object({ label: z.string().max(200), value: z.number() })).max(50),
  }).passthrough(),
});

router.get("/pinned", async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const rows = await db
    .selectFrom("sales_analysis_pinned")
    .select(["id", "title", "question", "spec", "position", sql<string>`created_at::text`.as("created_at")])
    .where("user_id", "=", userId)
    .orderBy("position", "asc")
    .orderBy("created_at", "asc")
    .execute();
  res.json({ pinned: rows });
});

router.post("/pinned", async (req: AuthedRequest, res) => {
  const parsed = pinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
  const userId = req.user!.id;
  const max = await db
    .selectFrom("sales_analysis_pinned")
    .select(sql<number>`coalesce(max(position), -1)`.as("m"))
    .where("user_id", "=", userId)
    .executeTakeFirst();
  const inserted = await db
    .insertInto("sales_analysis_pinned")
    .values({
      user_id: userId,
      title: parsed.data.title,
      question: parsed.data.question ?? null,
      spec: JSON.stringify(parsed.data.spec),
      position: Number(max?.m ?? -1) + 1,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  res.json({ id: inserted.id });
});

router.delete("/pinned/:id", async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  await db
    .deleteFrom("sales_analysis_pinned")
    .where("user_id", "=", userId)
    .where("id", "=", req.params.id)
    .execute();
  res.json({ ok: true });
});

export default router;
