/**
 * Connections (people) routes — all user-scoped via requireAuth.
 *   GET    /api/people                  list (paginated)
 *   POST   /api/people                  create one
 *   POST   /api/people/bulk             bulk upsert from parsed CSV
 *   GET    /api/people/:id
 *   PATCH  /api/people/:id
 *   DELETE /api/people/:id
 */
import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "../db/index.js";
import type { AuthedRequest } from "../auth/session.js";

const router = Router();

/** Normalise a name for cross-source matching (CRM contact name vs
 *  invitation name). Mirrors the logic used elsewhere in the app. */
function normaliseName(s: string | null | undefined): string {
  if (!s) return "";
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function normaliseLinkedIn(url: string | null | undefined): string {
  if (!url) return "";
  return url.toLowerCase().trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "");
}

const personInput = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  company: z.string().nullish(),
  position: z.string().nullish(),
  linkedinUrl: z.string().url().nullish(),
  email: z.string().email().nullish(),
  phone: z.string().nullish(),
  connectedOn: z.string().nullish(),
  category: z.string().nullish(),
  industry: z.string().nullish(),
});

router.get("/", async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const rows = await db
    .selectFrom("people")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("last_name", "asc")
    .limit(limit)
    .offset(offset)
    .execute();
  res.json({ people: rows, limit, offset });
});

router.post("/", async (req: AuthedRequest, res) => {
  const parsed = personInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });

  const p = parsed.data;
  const row = await db
    .insertInto("people")
    .values({
      user_id: req.user!.id,
      first_name: p.firstName,
      last_name: p.lastName,
      company: p.company ?? null,
      position: p.position ?? null,
      linkedin_url: p.linkedinUrl ?? null,
      email: p.email ?? null,
      phone: p.phone ?? null,
      connected_on: p.connectedOn ?? null,
      category: p.category ?? null,
      industry: p.industry ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  res.status(201).json(row);
});

router.post("/bulk", async (req: AuthedRequest, res) => {
  const parsed = z.object({
    people: z.array(personInput).max(10000),
    /** "invitation" rows are pending connection requests; "connection"
     *  is a real 1st-degree connection. Optional for back-compat. */
    kind: z.enum(["invitation", "connection"]).optional(),
    /** When true, replace the user's existing rows of this kind before
     *  inserting. Re-importing a fresh export shouldn't double-count. */
    replace: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  if (parsed.data.people.length === 0) return res.json({ inserted: 0 });

  // Self-heal so an environment that missed the kind migration doesn't
  // crash on the first import after deploy.
  try {
    await sql`ALTER TABLE people ADD COLUMN IF NOT EXISTS kind TEXT`.execute(db);
  } catch { /* already exists */ }

  const userId = req.user!.id;
  const kind = parsed.data.kind ?? null;

  // When replacing AND we have a kind, scope the wipe to that kind so a
  // fresh invitations import doesn't blow away connections (and vice versa).
  if (parsed.data.replace && kind) {
    await db
      .deleteFrom("people")
      .where("user_id", "=", userId)
      .where("kind", "=", kind)
      .execute();
  }

  // Insert in batches of 500 to keep params under Postgres' limit.
  const batches: (typeof parsed.data.people)[] = [];
  for (let i = 0; i < parsed.data.people.length; i += 500) {
    batches.push(parsed.data.people.slice(i, i + 500));
  }
  let inserted = 0;
  for (const batch of batches) {
    const res2 = await db
      .insertInto("people")
      .values(
        batch.map((p) => ({
          user_id: userId,
          first_name: p.firstName,
          last_name: p.lastName,
          company: p.company ?? null,
          position: p.position ?? null,
          linkedin_url: p.linkedinUrl ?? null,
          email: p.email ?? null,
          phone: p.phone ?? null,
          connected_on: p.connectedOn ?? null,
          category: p.category ?? null,
          industry: p.industry ?? null,
          kind,
        })),
      )
      .execute();
    inserted += Number(res2[0]?.numInsertedOrUpdatedRows ?? batch.length);
  }
  res.json({ inserted });
});

/** Lightweight list of people already in the user's LinkedIn network
 *  — sent invitations PLUS existing 1st-degree connections. Used by
 *  the CRM "Hide existing" filter to surface contacts the user still
 *  needs to reach out to. Returns only normalised name + normalised
 *  linkedin url so matching is cheap. The legacy /invitations name
 *  is kept since the response shape is a superset. */
router.get("/invitations", async (req: AuthedRequest, res) => {
  try {
    await sql`ALTER TABLE people ADD COLUMN IF NOT EXISTS kind TEXT`.execute(db);
  } catch { /* already exists */ }

  const rows = await db
    .selectFrom("people")
    .select(["first_name", "last_name", "linkedin_url", "kind"])
    .where("user_id", "=", req.user!.id)
    .where((eb) => eb.or([
      eb("kind", "=", "invitation"),
      eb("kind", "=", "connection"),
    ]))
    .execute();

  const invitations = rows.map((r) => ({
    name: normaliseName(`${r.first_name} ${r.last_name}`.trim()),
    linkedin: normaliseLinkedIn(r.linkedin_url),
    kind: r.kind ?? null,
  }));
  res.json({
    invitations,
    total: invitations.length,
    invitedCount: invitations.filter((i) => i.kind === "invitation").length,
    connectedCount: invitations.filter((i) => i.kind === "connection").length,
  });
});

router.get("/:id", async (req: AuthedRequest, res) => {
  const row = await db
    .selectFrom("people")
    .selectAll()
    .where("id", "=", req.params.id)
    .where("user_id", "=", req.user!.id)
    .executeTakeFirst();
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json(row);
});

router.patch("/:id", async (req: AuthedRequest, res) => {
  const parsed = personInput.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const p = parsed.data;
  const update: Record<string, unknown> = { updated_at: new Date() };
  if (p.firstName !== undefined) update.first_name = p.firstName;
  if (p.lastName !== undefined) update.last_name = p.lastName;
  if (p.company !== undefined) update.company = p.company ?? null;
  if (p.position !== undefined) update.position = p.position ?? null;
  if (p.linkedinUrl !== undefined) update.linkedin_url = p.linkedinUrl ?? null;
  if (p.email !== undefined) update.email = p.email ?? null;
  if (p.phone !== undefined) update.phone = p.phone ?? null;
  if (p.connectedOn !== undefined) update.connected_on = p.connectedOn ?? null;
  if (p.category !== undefined) update.category = p.category ?? null;
  if (p.industry !== undefined) update.industry = p.industry ?? null;

  const row = await db
    .updateTable("people")
    .set(update)
    .where("id", "=", req.params.id)
    .where("user_id", "=", req.user!.id)
    .returningAll()
    .executeTakeFirst();
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json(row);
});

router.delete("/:id", async (req: AuthedRequest, res) => {
  const result = await db
    .deleteFrom("people")
    .where("id", "=", req.params.id)
    .where("user_id", "=", req.user!.id)
    .executeTakeFirst();
  if (!result.numDeletedRows) return res.status(404).json({ error: "not_found" });
  res.status(204).end();
});

export default router;
