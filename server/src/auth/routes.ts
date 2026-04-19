/**
 * Auth routes:
 *   POST /api/auth/signup           { email, password, name? }
 *   POST /api/auth/login            { email, password }
 *   POST /api/auth/logout
 *   GET  /api/auth/session          → { user }
 *   GET  /api/auth/google           → redirect to Google
 *   GET  /api/auth/google/callback  → exchanges code, upserts user, sets cookie
 *
 * Google OAuth is implemented manually against Google's v4 endpoints; this
 * keeps the deps light. Swap in @auth/express any time — the DB schema matches.
 */
import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "../db/index.js";
import { env } from "../env.js";
import {
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  type AuthedRequest,
} from "./session.js";

const router = Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(120).optional(),
});

router.post("/signup", async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });

  const { email, password, name } = parsed.data;

  const existing = await db.selectFrom("users").select("id").where("email", "=", email).executeTakeFirst();
  if (existing) return res.status(409).json({ error: "email_taken" });

  const password_hash = await bcrypt.hash(password, 12);
  const user = await db
    .insertInto("users")
    .values({ email, password_hash, name: name ?? null })
    .returning(["id", "email", "name", "image"])
    .executeTakeFirstOrThrow();

  const { token, expires } = await createSession(user.id);
  setSessionCookie(res, token, expires);
  res.json({ user });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });

  const { email, password } = parsed.data;
  const user = await db
    .selectFrom("users")
    .select(["id", "email", "name", "image", "password_hash"])
    .where("email", "=", email)
    .executeTakeFirst();

  if (!user || !user.password_hash) return res.status(401).json({ error: "invalid_credentials" });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });

  const { token, expires } = await createSession(user.id);
  setSessionCookie(res, token, expires);
  res.json({ user: { id: user.id, email: user.email, name: user.name, image: user.image } });
});

router.post("/logout", async (req, res) => {
  const token = req.cookies?.nm_session;
  if (token) await destroySession(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/session", (req: AuthedRequest, res) => {
  res.json({ user: req.user ?? null });
});

export default router;
