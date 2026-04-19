/**
 * CRM — multi-board pipeline routes. All user-scoped.
 *
 *   GET    /api/crm/boards
 *   POST   /api/crm/boards                     { name, emoji? }
 *   PATCH  /api/crm/boards/:id                 { name?, emoji? }
 *   DELETE /api/crm/boards/:id
 *
 *   GET    /api/crm/boards/:id/contacts
 *   POST   /api/crm/boards/:id/contacts        (create one)
 *   POST   /api/crm/boards/:id/contacts/bulk   (CSV import; array)
 *   PATCH  /api/crm/contacts/:id
 *   DELETE /api/crm/contacts/:id
 */
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { AuthedRequest } from "../auth/session.js";
import { apolloMatchPerson, apolloConfigured } from "../integrations/apollo.js";
import { extractUserKeys } from "../ai/user-keys.js";

const router = Router();

// ---- helpers ----
const STAGES = ["new", "contacted", "replied", "meeting", "closed"] as const;
const TEMPS = ["hot", "warm", "cold"] as const;

function toCamelContact(row: Record<string, unknown>) {
  return {
    id: row.id,
    boardId: row.board_id,
    name: row.name,
    title: row.title,
    company: row.company,
    email: row.email,
    phone: row.phone,
    linkedin: row.linkedin,
    stage: row.stage,
    temp: row.temp,
    sent: row.sent,
    opens: row.opens,
    replies: row.replies,
    lastTouch: row.last_touch,
    nextStep: row.next_step,
    source: row.source,
    notes: row.notes,
    messageNotes: row.message_notes ?? null,
    customFields: (row.custom_fields ?? {}) as Record<string, string>,
    positionIdx: row.position_idx,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A user has access to a board if they own it OR are a member (via a
 * previously-accepted share token).
 */
async function ensureBoard(userId: string, boardId: string) {
  const owned = await db
    .selectFrom("crm_boards")
    .select(["id"])
    .where("id", "=", boardId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (owned) return owned;
  const membership = await db
    .selectFrom("crm_board_members")
    .innerJoin("crm_boards", "crm_boards.id", "crm_board_members.board_id")
    .select(["crm_boards.id"])
    .where("crm_board_members.board_id", "=", boardId)
    .where("crm_board_members.user_id", "=", userId)
    .executeTakeFirst();
  return membership;
}

function generateShareToken(): string {
  // URL-safe, 12 chars — unlikely collision across any realistic user base.
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // skip confusing chars
  let out = "";
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i % bytes.length]! % alphabet.length];
  return out;
}

// ---- Boards ----

router.get("/boards", async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  // Board ids the user can see: owned + shared-with-them.
  const memberIds = await db
    .selectFrom("crm_board_members")
    .select("board_id")
    .where("user_id", "=", userId)
    .execute();
  const sharedIds = memberIds.map((m) => m.board_id);

  const boards = await db
    .selectFrom("crm_boards")
    .leftJoin("crm_contacts", "crm_contacts.board_id", "crm_boards.id")
    .select(({ fn, eb }) => [
      "crm_boards.id",
      "crm_boards.user_id",
      "crm_boards.name",
      "crm_boards.emoji",
      "crm_boards.share_token",
      "crm_boards.created_at",
      "crm_boards.updated_at",
      fn.count<number>("crm_contacts.id").as("contact_count"),
      eb("crm_boards.user_id", "=", userId).as("owned"),
    ])
    .where((eb) =>
      sharedIds.length > 0
        ? eb.or([eb("crm_boards.user_id", "=", userId), eb("crm_boards.id", "in", sharedIds)])
        : eb("crm_boards.user_id", "=", userId),
    )
    .groupBy(["crm_boards.id"])
    .orderBy("crm_boards.created_at", "asc")
    .execute();

  // Auto-create a first board so the UI always has something to show.
  if (boards.length === 0) {
    const row = await db
      .insertInto("crm_boards")
      .values({ user_id: userId, name: "Outreach pipeline", emoji: "📣" })
      .returningAll()
      .executeTakeFirstOrThrow();
    return res.json({
      boards: [{
        id: row.id, name: row.name, emoji: row.emoji,
        contactCount: 0, shared: false, owned: true,
        createdAt: row.created_at, updatedAt: row.updated_at,
      }],
    });
  }

  res.json({
    boards: boards.map((b) => ({
      id: b.id, name: b.name, emoji: b.emoji,
      contactCount: Number(b.contact_count) || 0,
      owned: !!b.owned,
      shared: !b.owned, // for anyone not the owner, it reached them via a share token
      hasShareToken: !!b.share_token,
      createdAt: b.created_at, updatedAt: b.updated_at,
    })),
  });
});

router.post("/boards", async (req: AuthedRequest, res) => {
  const body = z.object({
    name: z.string().min(1).max(100),
    emoji: z.string().min(1).max(8).default("📣"),
  }).parse(req.body);

  const row = await db
    .insertInto("crm_boards")
    .values({ user_id: req.user!.id, name: body.name, emoji: body.emoji })
    .returningAll()
    .executeTakeFirstOrThrow();

  res.status(201).json({
    id: row.id, name: row.name, emoji: row.emoji,
    contactCount: 0, createdAt: row.created_at, updatedAt: row.updated_at,
  });
});

router.patch("/boards/:id", async (req: AuthedRequest, res) => {
  const body = z.object({
    name: z.string().min(1).max(100).optional(),
    emoji: z.string().min(1).max(8).optional(),
  }).parse(req.body);

  const update: Record<string, unknown> = { updated_at: new Date() };
  if (body.name !== undefined) update.name = body.name;
  if (body.emoji !== undefined) update.emoji = body.emoji;

  const row = await db
    .updateTable("crm_boards")
    .set(update)
    .where("id", "=", req.params.id)
    .where("user_id", "=", req.user!.id)
    .returningAll()
    .executeTakeFirst();
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json({
    id: row.id, name: row.name, emoji: row.emoji,
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
});

router.delete("/boards/:id", async (req: AuthedRequest, res) => {
  const r = await db
    .deleteFrom("crm_boards")
    .where("id", "=", req.params.id)
    .where("user_id", "=", req.user!.id)
    .executeTakeFirst();
  if (!r.numDeletedRows) return res.status(404).json({ error: "not_found" });
  res.status(204).end();
});

// ---- Contacts ----

const contactInput = z.object({
  name: z.string().min(1).max(200),
  title: z.string().nullish(),
  company: z.string().nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  linkedin: z.string().nullish(),
  stage: z.enum(STAGES).optional(),
  temp: z.enum(TEMPS).optional(),
  sent: z.number().int().min(0).optional(),
  opens: z.number().int().min(0).optional(),
  replies: z.number().int().min(0).optional(),
  lastTouch: z.string().nullish(),
  nextStep: z.string().nullish(),
  source: z.string().nullish(),
  notes: z.string().nullish(),
  messageNotes: z.string().nullish(),
  customFields: z.record(z.string().max(2000)).optional(),
});

router.get("/boards/:boardId/contacts", async (req: AuthedRequest, res) => {
  const board = await ensureBoard(req.user!.id, req.params.boardId);
  if (!board) return res.status(404).json({ error: "board_not_found" });

  const rows = await db
    .selectFrom("crm_contacts")
    .selectAll()
    .where("board_id", "=", req.params.boardId)
    .orderBy("position_idx", "asc")
    .orderBy("created_at", "asc")
    .execute();
  res.json({ contacts: rows.map(toCamelContact) });
});

router.post("/boards/:boardId/contacts", async (req: AuthedRequest, res) => {
  const board = await ensureBoard(req.user!.id, req.params.boardId);
  if (!board) return res.status(404).json({ error: "board_not_found" });

  const p = contactInput.parse(req.body);
  const row = await db
    .insertInto("crm_contacts")
    .values({
      board_id: board.id,
      user_id: req.user!.id,
      name: p.name,
      title: p.title ?? null,
      company: p.company ?? null,
      email: p.email ?? null,
      phone: p.phone ?? null,
      linkedin: p.linkedin ?? null,
      stage: p.stage ?? "new",
      temp: p.temp ?? "warm",
      sent: p.sent ?? 0,
      opens: p.opens ?? 0,
      replies: p.replies ?? 0,
      last_touch: p.lastTouch ?? null,
      next_step: p.nextStep ?? null,
      source: p.source ?? null,
      notes: p.notes ?? null,
      message_notes: p.messageNotes ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      custom_fields: (p.customFields ?? {}) as any,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  res.status(201).json(toCamelContact(row));
});

router.post("/boards/:boardId/contacts/bulk", async (req: AuthedRequest, res) => {
  const board = await ensureBoard(req.user!.id, req.params.boardId);
  if (!board) return res.status(404).json({ error: "board_not_found" });

  const body = z.object({ contacts: z.array(contactInput).max(10000) }).parse(req.body);
  if (body.contacts.length === 0) return res.json({ inserted: 0 });

  // Batch inserts of 500.
  const userId = req.user!.id;
  let inserted = 0;
  for (let i = 0; i < body.contacts.length; i += 500) {
    const batch = body.contacts.slice(i, i + 500);
    const result = await db
      .insertInto("crm_contacts")
      .values(
        batch.map((p) => ({
          board_id: board.id,
          user_id: userId,
          name: p.name,
          title: p.title ?? null,
          company: p.company ?? null,
          email: p.email ?? null,
          phone: p.phone ?? null,
          linkedin: p.linkedin ?? null,
          stage: p.stage ?? "new",
          temp: p.temp ?? "warm",
          sent: p.sent ?? 0,
          opens: p.opens ?? 0,
          replies: p.replies ?? 0,
          last_touch: p.lastTouch ?? null,
          next_step: p.nextStep ?? null,
          source: p.source ?? "CSV import",
          notes: p.notes ?? null,
          message_notes: p.messageNotes ?? null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          custom_fields: (p.customFields ?? {}) as any,
        })),
      )
      .execute();
    inserted += Number(result[0]?.numInsertedOrUpdatedRows ?? batch.length);
  }
  res.json({ inserted });
});

router.patch("/contacts/:id", async (req: AuthedRequest, res) => {
  const body = contactInput.partial().parse(req.body);
  const update: Record<string, unknown> = { updated_at: new Date() };
  const map = {
    name: "name", title: "title", company: "company", email: "email",
    phone: "phone", linkedin: "linkedin", stage: "stage", temp: "temp",
    sent: "sent", opens: "opens", replies: "replies",
    lastTouch: "last_touch", nextStep: "next_step", source: "source", notes: "notes",
    messageNotes: "message_notes",
  } as const;
  for (const [k, col] of Object.entries(map)) {
    const v = (body as Record<string, unknown>)[k];
    if (v !== undefined) update[col] = v ?? null;
  }

  if (body.customFields !== undefined) {
    // Merge with the existing bag so callers can patch a single key without
    // clobbering the rest. If a value is empty string, drop that key.
    const existing = await db
      .selectFrom("crm_contacts")
      .select("custom_fields")
      .where("id", "=", req.params.id)
      .where("user_id", "=", req.user!.id)
      .executeTakeFirst();
    if (!existing) return res.status(404).json({ error: "not_found" });
    const current = (existing.custom_fields ?? {}) as Record<string, string>;
    const patch = body.customFields;
    const merged: Record<string, string> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (v === "" || v === null || v === undefined) delete merged[k];
      else merged[k] = String(v);
    }
    // Kysely PostgresDialect sends JS objects as JSON to jsonb columns.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update.custom_fields = merged as any;
  }

  const row = await db
    .updateTable("crm_contacts")
    .set(update)
    .where("id", "=", req.params.id)
    .where("user_id", "=", req.user!.id)
    .returningAll()
    .executeTakeFirst();
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json(toCamelContact(row));
});

/**
 * Enrich every contact on a board via Apollo.io /people/match.
 * Fills in missing email, phone, LinkedIn, title, and company.
 */
router.post("/boards/:boardId/enrich", async (req: AuthedRequest, res) => {
  const userKeys = extractUserKeys(req);
  if (!apolloConfigured(userKeys)) {
    return res.status(501).json({
      error: "apollo_not_configured",
      message: "Apollo key missing — add it in Settings → API keys to enable enrichment.",
    });
  }
  const board = await ensureBoard(req.user!.id, req.params.boardId);
  if (!board) return res.status(404).json({ error: "board_not_found" });

  const rows = await db
    .selectFrom("crm_contacts")
    .selectAll()
    .where("board_id", "=", req.params.boardId)
    .execute();

  let enriched = 0;
  let skipped = 0;
  let alreadyHad = 0;

  for (const r of rows) {
    // Don't burn an Apollo call on anyone who already has an email —
    // that's the field this enrichment is here to fill.
    if (r.email && r.email.trim().length > 0) {
      alreadyHad++;
      continue;
    }

    const params: Parameters<typeof apolloMatchPerson>[0] = {};
    const parts = r.name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      params.firstName = parts[0];
      params.lastName = parts.slice(1).join(" ");
    } else {
      params.name = r.name;
    }
    if (r.company) params.organizationName = r.company;
    if (r.linkedin) params.linkedinUrl = r.linkedin;

    let person = null;
    try {
      person = await apolloMatchPerson({ ...params, userId: req.user!.id, userKeys });
    } catch (err) {
      console.warn("apollo match failed:", (err as Error).message);
    }
    if (!person) { skipped++; continue; }

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (!r.email && person.email) patch.email = person.email;
    if (!r.phone) {
      const phone = person.phone_numbers?.[0]?.sanitized_number ?? person.phone_numbers?.[0]?.raw_number;
      if (phone) patch.phone = phone;
    }
    if (!r.linkedin && person.linkedin_url) patch.linkedin = person.linkedin_url;
    if (!r.title && person.title) patch.title = person.title;
    if (!r.company && person.organization?.name) patch.company = person.organization.name;

    if (Object.keys(patch).length > 1) {
      await db.updateTable("crm_contacts").set(patch).where("id", "=", r.id).execute();
      enriched++;
    } else {
      skipped++;
    }
  }

  res.json({ enriched, skipped, alreadyHad, total: rows.length });
});

router.delete("/contacts/:id", async (req: AuthedRequest, res) => {
  const r = await db
    .deleteFrom("crm_contacts")
    .where("id", "=", req.params.id)
    .where("user_id", "=", req.user!.id)
    .executeTakeFirst();
  if (!r.numDeletedRows) return res.status(404).json({ error: "not_found" });
  res.status(204).end();
});

// ---- Sharing ----

/** Owner generates (or rotates) a share token for a board. */
router.post("/boards/:id/share", async (req: AuthedRequest, res) => {
  const row = await db
    .selectFrom("crm_boards")
    .select(["id", "share_token"])
    .where("id", "=", req.params.id)
    .where("user_id", "=", req.user!.id)
    .executeTakeFirst();
  if (!row) return res.status(404).json({ error: "not_found" });
  const token = row.share_token ?? generateShareToken();
  if (!row.share_token) {
    await db
      .updateTable("crm_boards")
      .set({ share_token: token })
      .where("id", "=", row.id)
      .execute();
  }
  res.json({ token });
});

/** Owner revokes the token and kicks every member. */
router.delete("/boards/:id/share", async (req: AuthedRequest, res) => {
  const row = await db
    .updateTable("crm_boards")
    .set({ share_token: null })
    .where("id", "=", req.params.id)
    .where("user_id", "=", req.user!.id)
    .returning("id")
    .executeTakeFirst();
  if (!row) return res.status(404).json({ error: "not_found" });
  await db.deleteFrom("crm_board_members").where("board_id", "=", row.id).execute();
  res.status(204).end();
});

/** Any authed user joins a board by pasting a token. */
router.post("/share/:token/join", async (req: AuthedRequest, res) => {
  const token = req.params.token;
  if (!token || token.length < 6) return res.status(400).json({ error: "bad_token" });
  const board = await db
    .selectFrom("crm_boards")
    .select(["id", "user_id", "name", "emoji"])
    .where("share_token", "=", token)
    .executeTakeFirst();
  if (!board) return res.status(404).json({ error: "token_not_found" });
  if (board.user_id === req.user!.id) {
    return res.json({ boardId: board.id, name: board.name, emoji: board.emoji, alreadyMember: true });
  }
  try {
    await db
      .insertInto("crm_board_members")
      .values({ board_id: board.id, user_id: req.user!.id })
      .execute();
  } catch {
    // unique constraint — already a member, idempotent.
  }
  res.json({ boardId: board.id, name: board.name, emoji: board.emoji });
});

export default router;
