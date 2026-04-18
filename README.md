# Network Map

Full-stack LinkedIn network explorer. Vite + React + Tailwind client, Express + TypeScript server, Postgres + Kysely, Auth.js (email + Google), server-side AI calls.

## Structure

```
.
├── client/     Vite + React + Tailwind SPA
├── server/     Express API, Kysely migrations, Auth.js, AI providers
├── shared/     Types shared between client and server
└── legacy/     Original static HTML/JS app (kept for reference)
```

## Prerequisites

- Node ≥ 20
- Postgres 14+ (local: `brew install postgresql@16 && brew services start postgresql@16`, or use [Neon](https://neon.tech) free tier)

## First-time setup

```bash
# 1. Install deps (workspace-wide)
npm install

# 2. Copy env file and fill in values
cp .env.example .env
# Edit .env — set DATABASE_URL, AUTH_SECRET (openssl rand -hex 32), and API keys

# 3. Create the database
createdb network_map   # or use your own DATABASE_URL target

# 4. Run migrations
npm run migrate
```

## Run in dev

Two terminals:

```bash
# Terminal 1 — API on :4000
npm run dev:server

# Terminal 2 — client on :5173
npm run dev:client
```

Or both at once: `npm run dev`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run client + server in parallel |
| `npm run build` | Build shared, server, then client |
| `npm run typecheck` | TS check across all workspaces |
| `npm run migrate` | Apply pending migrations |
| `npm run migrate:make <name>` | Create a new migration file |

## Deploy

See [DEPLOY.md](./DEPLOY.md) for Railway / Render / Fly recipes.

## Roadmap

- [x] Monorepo scaffold
- [x] Auth (email/password + Google)
- [x] Postgres schema
- [x] Server-side AI providers
- [ ] Port chat/discovery/enrichment from legacy
- [ ] Port 3D graph (Three.js → React)
- [ ] Stripe billing
- [ ] Apollo API integration
