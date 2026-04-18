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
import { z } from "zod";
import { db } from "../db/index.js";
import type { AuthedRequest } from "../auth/session.js";

const router = Router();

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
  const parsed = z.object({ people: z.array(personInput).max(10000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  if (parsed.data.people.length === 0) return res.json({ inserted: 0 });

  // Insert in batches of 500 to keep params under Postgres' limit.
  const userId = req.user!.id;
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
        })),
      )
      .execute();
    inserted += Number(res2[0]?.numInsertedOrUpdatedRows ?? batch.length);
  }
  res.json({ inserted });
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
