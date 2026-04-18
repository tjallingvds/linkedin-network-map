/**
 * Session management. DB-backed sessions compatible with the Auth.js `sessions`
 * table shape, so we can swap in @auth/express later without a migration.
 */
import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db } from "../db/index.js";

const COOKIE_NAME = "nm_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function newToken() {
  return randomBytes(32).toString("hex");
}

export async function createSession(userId: string) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await db.insertInto("sessions").values({ user_id: userId, session_token: token, expires }).execute();
  return { token, expires };
}

export async function destroySession(token: string) {
  await db.deleteFrom("sessions").where("session_token", "=", token).execute();
}

export function setSessionCookie(res: Response, token: string, expires: Date) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires,
    path: "/",
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

export interface AuthedRequest extends Request {
  user?: { id: string; email: string; name: string | null; image: string | null };
}

/** Attach user to req if a valid session cookie is present. Does NOT reject. */
export async function sessionMiddleware(req: AuthedRequest, _res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next();

  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .select([
      "users.id as id",
      "users.email as email",
      "users.name as name",
      "users.image as image",
      "sessions.expires as expires",
    ])
    .where("sessions.session_token", "=", token)
    .executeTakeFirst();

  if (!row) return next();
  if (new Date(row.expires as unknown as string) < new Date()) return next();

  req.user = { id: row.id, email: row.email, name: row.name, image: row.image };
  next();
}

/** Reject the request if no user is attached. */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "unauthorized" });
  next();
}
