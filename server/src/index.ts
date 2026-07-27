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
import outreachRoutes from "./routes/outreach/index.js";
import smartleadWebhookRoutes from "./routes/webhooks/smartlead.js";
import { reconcileAll } from "./integrations/outreach/reconcile.js";
import { lastRunAt, createJob, finishJob, failJob } from "./integrations/outreach/jobs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Process-level safety net ────────────────────────────────────────────────
// express-async-errors forwards a handler's *thrown/rejected* errors to the
// error middleware, but it can't catch an asynchronous 'error' event emitted
// on a socket — e.g. the completion route's keep-alive heartbeat writing its
// whitespace byte 10s after the client (or a proxy) silently dropped a
// long-running Find. With no listener, that event became an uncaughtException
// that killed the WHOLE process — every concurrent request then 502'd and
// Railway restarted the container. The route now listens on its own response,
// but these guards ensure no single stray socket/promise error can ever take
// the server down again.
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  // Writes to an already-closed client socket surface here as EPIPE /
  // ECONNRESET / ERR_STREAM_*. The request they belong to is already over, so
  // they're benign — log and keep serving every other in-flight request.
  const code = (err as NodeJS.ErrnoException).code ?? "";
  const benign = ["EPIPE", "ECONNRESET", "ERR_STREAM_WRITE_AFTER_END", "ERR_STREAM_DESTROYED"];
  if (benign.includes(code) || benign.includes(err.name)) {
    console.warn(`[process] ignored benign socket error: ${code || err.message}`);
    return;
  }
  // Anything else means we may be in a corrupted state — exit so Railway
  // restarts a clean process rather than serving from a half-broken one.
  console.error("[process] uncaughtException — exiting for clean restart:", err);
  process.exit(1);
});

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

// Smartlead webhooks MUST see the raw request bytes to verify the HMAC
// signature, so this is mounted BEFORE express.json() with a raw-body parser.
// It's a public route (authenticated by URL token + signature), never behind
// requireAuth. Keep it above the JSON middleware.
app.use("/hooks/smartlead", express.raw({ type: "*/*", limit: "2mb" }), smartleadWebhookRoutes);

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
app.use("/api/outreach", requireAuth, outreachRoutes);

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

/** Daily outreach reconciliation (spec §6) — a drift check, not an event source.
 *
 *  Ticks hourly but only runs when the LAST RECORDED RUN is over ~20h old. A
 *  naive setInterval(24h) restarts on every deploy, so on a daily-deploy
 *  cadence the 24h mark is never reached and the job silently never runs. The
 *  last-run timestamp lives in outreach_jobs, so restarts don't reset it.
 *
 *  Still assumes a single instance: two containers could both pass the check in
 *  the same hour. Reconciliation is idempotent, so a double run is harmless —
 *  but a horizontally-scaled deploy should move this to an external scheduler. */
function startReconcileScheduler() {
  const HOUR_MS = 60 * 60 * 1000;
  const MIN_GAP_MS = 20 * HOUR_MS;
  const tick = async () => {
    try {
      const last = await lastRunAt("reconcile");
      if (last && Date.now() - last.getTime() < MIN_GAP_MS) return;
      const jobId = await createJob(null, "reconcile");
      try {
        await reconcileAll();
        await finishJob(jobId, { ok: true });
      } catch (err) {
        await failJob(jobId, (err as Error).message);
        throw err;
      }
    } catch (err) {
      console.error("[reconcile] scheduled run failed:", (err as Error).message);
    }
  };
  setInterval(() => { void tick(); }, HOUR_MS).unref();
  // Check shortly after boot too, so a server that restarts daily still runs.
  setTimeout(() => { void tick(); }, 5 * 60 * 1000).unref();
}

runPendingMigrations().finally(() => {
  app.listen(env.PORT, () => {
    console.log(`✔ API listening on ${env.SERVER_URL} (NODE_ENV=${env.NODE_ENV})`);
    startReconcileScheduler();
  });
});
