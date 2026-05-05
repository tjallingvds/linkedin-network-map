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
