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
import billingRoutes from "./routes/billing.js";
import apolloRoutes from "./routes/apollo.js";
import crmRoutes from "./routes/crm.js";
import usageRoutes from "./routes/usage.js";
import { stripeWebhookHandler } from "./routes/billing-webhook.js";

const app = express();

app.set("trust proxy", 1); // needed on Railway/Fly/etc. for secure cookies

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: env.CLIENT_URL, credentials: true }));
app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));

// Stripe webhook needs raw body; mount BEFORE express.json().
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);

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
app.use("/api/billing", requireAuth, billingRoutes);
app.use("/api/apollo", requireAuth, apolloRoutes);
app.use("/api/crm", requireAuth, crmRoutes);
app.use("/api/usage", requireAuth, usageRoutes);

// JSON 404
app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "server_error", message: err.message });
});

app.listen(env.PORT, () => {
  console.log(`✔ API listening on ${env.SERVER_URL} (NODE_ENV=${env.NODE_ENV})`);
});
