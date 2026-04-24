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
import { sql } from "kysely";
import { db } from "../db/index.js";
import type { AuthedRequest } from "../auth/session.js";
import { apolloMatchPerson, apolloConfigured } from "../integrations/apollo.js";
import { extractUserKeys } from "../ai/user-keys.js";
import { tavilySearch } from "../ai/tavily.js";
import { aiJson } from "../ai/json.js";
import { availableProviders } from "../ai/providers.js";
import { env } from "../env.js";

const router = Router();

// ---- helpers ----
// Stage labels are fully user-configurable now (stored client-side per board)
// so the server only enforces a sane length bound. TEMPs stay enumerated.
const TEMPS = ["hot", "warm", "cold"] as const;

/** Normalise a name for dedup — lowercase, strip punctuation, collapse
 *  whitespace. So "Jane  Doe", "Jane Doe", and "jane doe" all collide. */
function normalizeNameForDedup(name: string | null | undefined): string {
  if (!name) return "";
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Normalise a LinkedIn URL for dedup — strip protocol, www, trailing
 *  slash, query string, and the vanity-URL prefix so both the canonical
 *  and the permalink form collide. */
function normalizeLinkedInForDedup(url: string | null | undefined): string {
  if (!url) return "";
  const u = url.toLowerCase().trim();
  if (!u) return "";
  return u
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "");
}

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
    background: (row.background as string | null | undefined) ?? null,
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

  // Self-heal the stages column so shared collaborators see the same
  // kanban config even if the migration never ran on this environment.
  try {
    await sql`ALTER TABLE crm_boards ADD COLUMN IF NOT EXISTS stages JSONB`.execute(db);
  } catch (err) {
    console.warn("[crm] ensure stages column failed:", (err as Error).message);
  }

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
      "crm_boards.stages",
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
      stages: b.stages ?? null,
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
  const stageDef = z.object({
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(60),
    color: z.string().min(1).max(80),
    tint: z.string().min(1).max(80),
  });
  const body = z.object({
    name: z.string().min(1).max(100).optional(),
    emoji: z.string().min(1).max(8).optional(),
    stages: z.array(stageDef).min(1).max(20).nullable().optional(),
  }).parse(req.body);

  // Shared members can edit board config (stages) — the whole point of
  // sharing is collaborative editing. Owner-only for name/emoji to keep
  // rename surprises contained.
  const ownedOrMember = await ensureBoard(req.user!.id, req.params.id);
  if (!ownedOrMember) return res.status(404).json({ error: "not_found" });
  const ownerCheck = await db
    .selectFrom("crm_boards")
    .select("user_id")
    .where("id", "=", req.params.id)
    .executeTakeFirst();
  const isOwner = ownerCheck?.user_id === req.user!.id;
  if (!isOwner && (body.name !== undefined || body.emoji !== undefined)) {
    return res.status(403).json({ error: "owner_only", message: "Only the owner can rename this board." });
  }

  try {
    await sql`ALTER TABLE crm_boards ADD COLUMN IF NOT EXISTS stages JSONB`.execute(db);
  } catch { /* already exists */ }

  const update: Record<string, unknown> = { updated_at: new Date() };
  if (body.name !== undefined) update.name = body.name;
  if (body.emoji !== undefined) update.emoji = body.emoji;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (body.stages !== undefined) update.stages = body.stages as any;

  const row = await db
    .updateTable("crm_boards")
    .set(update)
    .where("id", "=", req.params.id)
    .returningAll()
    .executeTakeFirst();
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json({
    id: row.id, name: row.name, emoji: row.emoji,
    stages: row.stages ?? null,
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
  // Stages are user-configurable per board (client-side config). Any short
  // string is accepted — validation only guards length.
  stage: z.string().min(1).max(40).optional(),
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

  // Auto-dedup sweep on board load. Two rows are duplicates if they share
  // a normalised LinkedIn URL OR (both have no LinkedIn AND share a
  // normalised name). Within each duplicate group, the OLDEST row is the
  // keeper (it carries user-managed stage / temp / notes progress), but
  // before we delete the newer dupes we MERGE any enrichment fields the
  // keeper is missing from them — email, phone, linkedin, title, company,
  // background. Previously a naive "keep oldest, delete newer" lost any
  // enrichment (Apollo email, LLM background) that happened to land on
  // the newer row — which is exactly when a bad-quality row gets
  // enriched into matching an older clean row.
  const allForDedup = await db
    .selectFrom("crm_contacts")
    .selectAll()
    .where("board_id", "=", req.params.boardId)
    .orderBy("created_at", "asc")
    .execute();
  const groups = new Map<string, typeof allForDedup>();
  for (const r of allForDedup) {
    const li = normalizeLinkedInForDedup(r.linkedin ?? null);
    const name = normalizeNameForDedup(r.name);
    const key = li ? `li:${li}` : name ? `nm:${name}` : `id:${r.id}`;
    const arr = groups.get(key);
    if (arr) arr.push(r); else groups.set(key, [r]);
  }
  const toDelete: string[] = [];
  const MERGE_FIELDS = ["email", "phone", "linkedin", "title", "company", "background", "notes", "message_notes"] as const;
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    // Keeper = oldest (first, because ORDER BY created_at ASC).
    const keeper = group[0]!;
    const patch: Partial<Record<(typeof MERGE_FIELDS)[number], string>> = {};
    for (const field of MERGE_FIELDS) {
      const current = keeper[field] as string | null | undefined;
      if (current && current.trim().length > 0) continue;
      // Find the first dupe that has a value for this field.
      for (let i = 1; i < group.length; i++) {
        const val = group[i]![field] as string | null | undefined;
        if (val && val.trim().length > 0) { patch[field] = val; break; }
      }
    }
    if (Object.keys(patch).length > 0) {
      await db
        .updateTable("crm_contacts")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .set({ ...patch, updated_at: new Date() as any })
        .where("id", "=", keeper.id)
        .execute();
    }
    for (let i = 1; i < group.length; i++) toDelete.push(group[i]!.id);
  }
  if (toDelete.length > 0) {
    await db.deleteFrom("crm_contacts").where("id", "in", toDelete).execute();
    console.log(`[crm] auto-deduped ${toDelete.length} contact(s) on board ${req.params.boardId} (merged enrichment first)`);
  }

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

  // Dedup on this board — same normalized name OR same normalized LinkedIn
  // URL → return the existing row instead of inserting. Idempotent so the
  // "Add to board" UI flow doesn't silently double-add the same person when
  // the user clicks twice or re-imports a CSV they already imported.
  const existingRows = await db
    .selectFrom("crm_contacts")
    .select(["id", "name", "linkedin"])
    .where("board_id", "=", board.id)
    .execute();
  const newName = normalizeNameForDedup(p.name);
  const newLi = normalizeLinkedInForDedup(p.linkedin ?? null);
  const dup = existingRows.find((r) => {
    const rName = normalizeNameForDedup(r.name);
    const rLi = normalizeLinkedInForDedup(r.linkedin ?? null);
    if (newLi && rLi && newLi === rLi) return true;
    if (newName && rName && newName === rName) return true;
    return false;
  });
  if (dup) {
    const full = await db
      .selectFrom("crm_contacts")
      .selectAll()
      .where("id", "=", dup.id)
      .executeTakeFirstOrThrow();
    return res.status(200).json({ ...toCamelContact(full), duplicate: true });
  }

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
  if (body.contacts.length === 0) return res.json({ inserted: 0, skipped: 0 });

  // Dedup: both (a) within the incoming batch and (b) against rows already
  // on the board. Match on normalized name OR normalized LinkedIn URL so
  // CSV re-imports, "Add all N to board" clicks after a second search, and
  // chat-side "find more" runs don't silently duplicate the same person.
  const existingRows = await db
    .selectFrom("crm_contacts")
    .select(["name", "linkedin"])
    .where("board_id", "=", board.id)
    .execute();
  const seenNames = new Set<string>();
  const seenLi = new Set<string>();
  for (const r of existingRows) {
    const n = normalizeNameForDedup(r.name);
    const l = normalizeLinkedInForDedup(r.linkedin ?? null);
    if (n) seenNames.add(n);
    if (l) seenLi.add(l);
  }
  const unique: typeof body.contacts = [];
  let skipped = 0;
  for (const p of body.contacts) {
    const n = normalizeNameForDedup(p.name);
    const l = normalizeLinkedInForDedup(p.linkedin ?? null);
    const isDup = (l && seenLi.has(l)) || (n && seenNames.has(n));
    if (isDup) { skipped++; continue; }
    if (n) seenNames.add(n);
    if (l) seenLi.add(l);
    unique.push(p);
  }
  if (unique.length === 0) return res.json({ inserted: 0, skipped });

  // Batch inserts of 500.
  const userId = req.user!.id;
  let inserted = 0;
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
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
  res.json({ inserted, skipped });
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

/**
 * Background-info enrichment. For every contact on the board with no
 * existing `background`, run a Tavily search + LLM extraction to pull
 * a few recent interesting items (posts, talks, funny/notable things
 * they've said publicly) WITH source URLs. Stored as markdown in the
 * contact's `background` column.
 *
 * Separate from /enrich (which uses Apollo for contact info) because:
 *   - different data source (web vs. Apollo db)
 *   - different cost profile (LLM + Tavily per contact)
 *   - different field written
 */
router.post("/boards/:boardId/background", async (req: AuthedRequest, res) => {
  const userKeys = extractUserKeys(req);
  const tavilyKey = userKeys?.tavily ?? env.TAVILY_API_KEY;
  if (!tavilyKey) {
    return res.status(501).json({
      error: "tavily_not_configured",
      message: "Tavily key missing — add it in Settings → API keys to enable background lookup.",
    });
  }
  const provider = availableProviders(userKeys)[0];
  if (!provider) {
    return res.status(501).json({
      error: "llm_not_configured",
      message: "No LLM provider configured — add an OpenAI / Anthropic / DeepSeek key in Settings.",
    });
  }
  const board = await ensureBoard(req.user!.id, req.params.boardId);
  if (!board) return res.status(404).json({ error: "board_not_found" });

  // Belt-and-suspenders: guarantee the background column exists even if the
  // migration never ran (shouldn't happen, but the user hit a case where
  // backgrounds weren't persisting — this makes the endpoint self-healing).
  try {
    await sql`ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS background TEXT`.execute(db);
  } catch (err) {
    console.warn("[background] ensure-column failed:", (err as Error).message);
  }

  const rows = await db
    .selectFrom("crm_contacts")
    .selectAll()
    .where("board_id", "=", req.params.boardId)
    .execute();

  let filled = 0;
  let skipped = 0;
  let alreadyHad = 0;

  for (const r of rows) {
    if (r.background && r.background.trim().length > 0) { alreadyHad++; continue; }

    // Query targets the person + company so Tavily surfaces their own
    // posts, talks, and mentions rather than random people with the same
    // name. LinkedIn URL, if we have it, narrows further.
    const q = [r.name, r.company, "posts OR talk OR interview"].filter(Boolean).join(" ");
    let results: Awaited<ReturnType<typeof tavilySearch>> = [];
    try {
      results = await tavilySearch(q, { depth: "advanced", maxResults: 5, userId: req.user!.id, userKeys });
    } catch (err) {
      console.warn(`[background] tavily failed for ${r.name}:`, (err as Error).message);
    }
    if (results.length === 0) { skipped++; continue; }

    const context = results
      .map((x) => `[${x.title}](${x.url})\n${(x.content ?? "").slice(0, 1500)}`)
      .join("\n\n---\n\n");

    let summary: string | null = null;
    try {
      const out = await aiJson<{ background: string }>(
        provider,
        "You write a short, factual background brief for a sales/BD rep about a single prospect. " +
        "Pull 2-4 specific, recent, CONCRETE things from the search results: a post they wrote, a talk they gave, " +
        "a product they shipped, a notable opinion or anecdote. Prefer the quirky and specific over generic platitudes. " +
        "Cite EACH item inline with a markdown link to the source URL. " +
        "Never invent facts not in the sources. Keep total length under 600 characters. " +
        "No greeting, no preamble, no meta-commentary — just the bullet list.",
        `Prospect: ${r.name}${r.title ? ", " + r.title : ""}${r.company ? " @ " + r.company : ""}\n\nSearch results:\n${context}\n\n` +
        `Return {"background": "<markdown bullet list with inline [links](url), under 600 chars>"}.`,
        { maxTokens: 900, userId: req.user!.id, userKeys },
      );
      const trimmed = out.background?.trim();
      if (trimmed && trimmed.length > 0) summary = trimmed;
    } catch (err) {
      console.warn(`[background] aiJson failed for ${r.name}:`, (err as Error).message);
    }

    if (!summary) { skipped++; continue; }

    try {
      const writeResult = await db
        .updateTable("crm_contacts")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .set({ background: summary, updated_at: new Date() as any })
        .where("id", "=", r.id)
        .execute();
      const rowsAffected = Number(writeResult[0]?.numUpdatedRows ?? 0);
      if (rowsAffected === 0) {
        console.warn(`[background] 0 rows updated for ${r.name} (id=${r.id}) — background not persisted`);
        skipped++;
        continue;
      }
      console.log(`[background] saved for ${r.name} (${summary.length} chars)`);
      filled++;
    } catch (err) {
      console.error(`[background] DB write failed for ${r.name}:`, (err as Error).message);
      skipped++;
    }
  }

  res.json({ filled, skipped, alreadyHad, total: rows.length });
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

/**
 * Cleanup-from-external: the user uploads a CSV of contacts they already
 * have in a different CRM (e.g. Salesforce, HubSpot) and we remove any
 * matching rows from ALL their own CRM boards. Idempotent — running it
 * twice with the same CSV is safe.
 *
 * Matching priority per incoming row:
 *   1. normalised LinkedIn URL (strongest)
 *   2. normalised email
 *   3. normalised name + normalised company (drops false positives like
 *      two different "John Smith"s at different firms)
 *   4. normalised name alone, ONLY when neither side has a company — the
 *      user explicitly said "remove duplicate names"
 *
 * Scope: removes across ALL boards the user owns. Shared-member boards
 * they don't own are left alone — someone else's outreach pipeline isn't
 * ours to edit.
 */
router.post("/cleanup-from-external", async (req: AuthedRequest, res) => {
  const rowSchema = z.object({
    name: z.string().nullish(),
    email: z.string().nullish(),
    linkedin: z.string().nullish(),
    company: z.string().nullish(),
  });
  const body = z.object({ rows: z.array(rowSchema).max(50000) }).parse(req.body);
  if (body.rows.length === 0) return res.json({ removed: 0, boardsAffected: 0, scanned: 0 });

  // Build indexed lookup sets for the uploaded CSV so the scan is O(n+m).
  const externalLi = new Set<string>();
  const externalEmail = new Set<string>();
  const externalNameCompany = new Set<string>();
  const externalNameOnly = new Set<string>();
  for (const r of body.rows) {
    const li = normalizeLinkedInForDedup(r.linkedin ?? null);
    if (li) externalLi.add(li);
    const email = (r.email ?? "").toLowerCase().trim();
    if (email) externalEmail.add(email);
    const name = normalizeNameForDedup(r.name ?? null);
    const company = (r.company ?? "").toLowerCase().trim();
    if (name && company) externalNameCompany.add(`${name}|${company}`);
    else if (name) externalNameOnly.add(name);
  }

  // Pull every contact on boards the user owns.
  const userId = req.user!.id;
  const myBoards = await db
    .selectFrom("crm_boards")
    .select("id")
    .where("user_id", "=", userId)
    .execute();
  const myBoardIds = myBoards.map((b) => b.id);
  if (myBoardIds.length === 0) return res.json({ removed: 0, boardsAffected: 0, scanned: 0 });

  const contacts = await db
    .selectFrom("crm_contacts")
    .select(["id", "board_id", "name", "email", "linkedin", "company"])
    .where("board_id", "in", myBoardIds)
    .execute();

  const toDelete: string[] = [];
  const boardsHit = new Set<string>();
  for (const c of contacts) {
    const li = normalizeLinkedInForDedup(c.linkedin ?? null);
    if (li && externalLi.has(li)) {
      toDelete.push(c.id); boardsHit.add(c.board_id); continue;
    }
    const email = (c.email ?? "").toLowerCase().trim();
    if (email && externalEmail.has(email)) {
      toDelete.push(c.id); boardsHit.add(c.board_id); continue;
    }
    const name = normalizeNameForDedup(c.name);
    const company = (c.company ?? "").toLowerCase().trim();
    if (name && company && externalNameCompany.has(`${name}|${company}`)) {
      toDelete.push(c.id); boardsHit.add(c.board_id); continue;
    }
    // Name-only fallback — only when BOTH sides lack a company. Same logic
    // as the on-load dedup sweep: two distinct people with the same name
    // at different companies should both survive.
    if (name && !company && externalNameOnly.has(name)) {
      toDelete.push(c.id); boardsHit.add(c.board_id);
    }
  }

  if (toDelete.length === 0) {
    return res.json({ removed: 0, boardsAffected: 0, scanned: contacts.length });
  }

  // Chunk deletes so we don't blow past any Postgres parameter limits.
  for (let i = 0; i < toDelete.length; i += 1000) {
    const batch = toDelete.slice(i, i + 1000);
    await db.deleteFrom("crm_contacts").where("id", "in", batch).execute();
  }

  res.json({
    removed: toDelete.length,
    boardsAffected: boardsHit.size,
    scanned: contacts.length,
  });
});

export default router;
