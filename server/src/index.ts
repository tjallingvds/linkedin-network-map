import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, promises as fs } from "node:fs";
import express from "express";
// Side-effect import: monkey-patches Express 4 so async route handlers that
// throw or reject forward the error to the error-handling middleware below
// instead of becoming an unhandled rejection (which Node 20 turns into a
// process crash). Without this, a single zod validation throw would knock
// the whole server over and Railway would show its crash screen.
import "express-async-errors";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { Migrator, FileMigrationProvider } from "kysely";
import { db } from "./db/index.js";
import { env } from "./env.js";
import { sessionMiddleware, requireAuth } from "./auth/session.js";
import authRoutes from "./auth/routes.js";
import peopleRoutes from "./routes/people.js";
import chatsRoutes from "./routes/chats.js";
import apolloRoutes from "./routes/apollo.js";
import crmRoutes from "./routes/crm.js";
import usageRoutes from "./routes/usage.js";
import messagesLogRoutes from "./routes/messages_log.js";
import salesRoutes from "./routes/sales/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.set("trust proxy", 1); // needed on Railway/Fly/etc. for secure cookies

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: env.CLIENT_URL,
  credentials: true,
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-User-Openai-Key",
    "X-User-Anthropic-Key",
    "X-User-Deepseek-Key",
    "X-User-Tavily-Key",
    "X-User-Apollo-Key",
  ],
}));
app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));

// Bumped to 25mb so the LinkedIn messages.csv import (parsed client-side
// into a JSON array of up to 50k rows × ~300 bytes each) doesn't hit the
// default 100kb limit. Smaller endpoints still have their own zod caps.
app.use(express.json({ limit: "25mb" }));
app.use(cookieParser());
app.use(sessionMiddleware);

// Health check (used by Railway/Render)
app.get("/health", (_req, res) => res.json({ ok: true }));

// Public auth routes
app.use("/api/auth", authRoutes);

// Protected routes
app.use("/api/people", requireAuth, peopleRoutes);
app.use("/api/chats", requireAuth, chatsRoutes);
app.use("/api/apollo", requireAuth, apolloRoutes);
app.use("/api/crm", requireAuth, crmRoutes);
app.use("/api/usage", requireAuth, usageRoutes);
app.use("/api/messages-log", requireAuth, messagesLogRoutes);
app.use("/api/sales", requireAuth, salesRoutes);

// JSON 404 for the API surface.
app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

// ---- Legacy static app (pre-rewrite, self-contained browser app) ----
// The pre-TS legacy version lives in /legacy at the repo root. It's a
// pure static site (index.html + css/js + Three.js CDN), all auth and AI
// calls are browser-side with user-provided keys. We mount it at /legacy
// so the new app can escape-hatch to "the old thing that worked" while
// we iron out the rewrite.
const legacyDir = path.resolve(__dirname, "../../legacy");
if (existsSync(path.join(legacyDir, "index.html"))) {
  app.use("/legacy", express.static(legacyDir, { maxAge: "1h" }));
  console.log(`✔ Serving legacy app from ${legacyDir} at /legacy`);
}

// ---- Static client ----
// The server Dockerfile copies client/dist next to server/dist so this image
// can serve the SPA from the same origin. Locally (dev), Vite serves the
// client on its own port and this branch is inactive.
const clientDist = path.resolve(__dirname, "../../client/dist");
if (existsSync(path.join(clientDist, "index.html"))) {
  app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path === "/health" || req.path.startsWith("/legacy")) return next();
    res.sendFile(path.join(clientDist, "index.html"));
  });
  console.log(`✔ Serving client from ${clientDist}`);
} else {
  console.log("ℹ No client bundle found — running in API-only mode.");
}

// Error handler — turn zod validation throws into clean 400s instead of
// generic 500s, and keep everything else as a 500 with the message.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Treat anything that quacks like a ZodError (issues array) as a 400 — we
  // don't import zod here just for the type so the duck-check is enough.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const issues = (err as any)?.issues;
  if (Array.isArray(issues)) {
    return res.status(400).json({ error: "bad_request", issues });
  }
  console.error(err);
  res.status(500).json({ error: "server_error", message: err.message });
});

/** Auto-run pending migrations at boot. The Dockerfile also runs
 *  `migrate.js up` before starting, so this is a no-op in production; it
 *  matters in dev (`npm run dev:server`) where otherwise the user has to
 *  remember `npm run migrate` after every schema change. A new column
 *  (e.g. crm_contacts.background) not getting added locally is what
 *  caused backgrounds to appear to "not save" — the UPDATE silently
 *  wrote to a non-existent column in older pg versions that auto-ignore. */
async function runPendingMigrations() {
  try {
    const migrator = new Migrator({
      db,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: path.join(__dirname, "db", "migrations"),
      }),
    });
    const { error, results } = await migrator.migrateToLatest();
    results?.forEach((r) => {
      if (r.status === "Success") console.log(`✓ migrated up: ${r.migrationName}`);
      if (r.status === "Error") console.error(`✗ failed:     ${r.migrationName}`);
    });
    if (error) console.error("[migrate] boot-time migration failed:", error);
    else console.log("[migrate] schema up-to-date");
  } catch (err) {
    console.error("[migrate] boot-time migration crashed:", (err as Error).message);
  }
}

runPendingMigrations().finally(() => {
  app.listen(env.PORT, () => {
    console.log(`✔ API listening on ${env.SERVER_URL} (NODE_ENV=${env.NODE_ENV})`);
  });
});
