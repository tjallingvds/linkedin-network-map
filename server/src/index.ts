import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./env.js";
import { sessionMiddleware, requireAuth } from "./auth/session.js";
import authRoutes from "./auth/routes.js";
import peopleRoutes from "./routes/people.js";
import chatsRoutes from "./routes/chats.js";
import apolloRoutes from "./routes/apollo.js";
import crmRoutes from "./routes/crm.js";
import usageRoutes from "./routes/usage.js";

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

app.use(express.json({ limit: "10mb" }));
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

// JSON 404 for the API surface.
app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

// ---- Static client ----
// The server Dockerfile copies client/dist next to server/dist so this image
// can serve the SPA from the same origin. Locally (dev), Vite serves the
// client on its own port and this branch is inactive.
const clientDist = path.resolve(__dirname, "../../client/dist");
if (existsSync(path.join(clientDist, "index.html"))) {
  app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path === "/health") return next();
    res.sendFile(path.join(clientDist, "index.html"));
  });
  console.log(`✔ Serving client from ${clientDist}`);
} else {
  console.log("ℹ No client bundle found — running in API-only mode.");
}

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "server_error", message: err.message });
});

app.listen(env.PORT, () => {
  console.log(`✔ API listening on ${env.SERVER_URL} (NODE_ENV=${env.NODE_ENV})`);
});
