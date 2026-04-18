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

// ---------- Google OAuth ----------

router.get("/google", (_req, res) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return res.status(501).json({ error: "google_oauth_not_configured" });
  }
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.SERVER_URL}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "consent",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

router.get("/google/callback", async (req, res) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return res.status(501).json({ error: "google_oauth_not_configured" });
  }
  const code = req.query.code as string | undefined;
  if (!code) return res.status(400).send("missing code");

  // Exchange code for tokens.
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.SERVER_URL}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return res.status(500).send("token exchange failed");
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    id_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
    scope: string;
  };

  // Fetch profile.
  const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) return res.status(500).send("profile fetch failed");
  const profile = (await profileRes.json()) as {
    sub: string;
    email: string;
    email_verified: boolean;
    name?: string;
    picture?: string;
  };

  // Upsert user + account.
  let user = await db
    .selectFrom("users")
    .select(["id", "email", "name", "image"])
    .where("email", "=", profile.email)
    .executeTakeFirst();

  if (!user) {
    user = await db
      .insertInto("users")
      .values({
        email: profile.email,
        name: profile.name ?? null,
        image: profile.picture ?? null,
        email_verified: profile.email_verified ? new Date() : null,
      })
      .returning(["id", "email", "name", "image"])
      .executeTakeFirstOrThrow();
  }

  const existingAccount = await db
    .selectFrom("accounts")
    .select("id")
    .where("provider", "=", "google")
    .where("provider_account_id", "=", profile.sub)
    .executeTakeFirst();

  if (!existingAccount) {
    await db
      .insertInto("accounts")
      .values({
        user_id: user.id,
        type: "oauth",
        provider: "google",
        provider_account_id: profile.sub,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
        token_type: tokens.token_type,
        scope: tokens.scope,
        id_token: tokens.id_token,
      })
      .execute();
  }

  const { token, expires } = await createSession(user.id);
  setSessionCookie(res, token, expires);
  res.redirect(env.CLIENT_URL);
});

export default router;
