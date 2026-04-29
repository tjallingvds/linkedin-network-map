# Network Map

AI-driven sales prospecting + lightweight CRM. Type a brief in chat ("Find Heads of AI at mid-tier US investment banks, 50 prospects") and get a ranked list of real people with LinkedIn URLs and outreach signals, drawn from live web search. Save them to a kanban-style board, draft personalised outreach, and share boards with teammates.

The web-search and LLM cost is borne **by the user** when they paste their own API keys in Settings (BYOK) — the server prefers user keys over its own env keys and skips usage accounting in that case. A workspace-shared key set is also supported via the server's env vars.

Stack: Vite + React + TypeScript SPA, Express + TypeScript API, Postgres via Kysely, Auth.js (email/password + Google OAuth), Tavily for web search, OpenAI/Anthropic/DeepSeek for the LLM calls, Apollo.io for verified contact lookup.

## What it actually does

The chat dispatches on the brief's intent. All modes run server-side; the client renders the typed `CompletionResult`.

| Chat mode | Triggered when… | What it does |
|---|---|---|
| **Find** | Default for any prospecting brief | Generates LinkedIn-flavoured Tavily queries, fans them out across up to 3 rounds, extracts grounded candidates from the snippets with a strict prompt, and returns a ranked prospect list. Has a clarify gate that asks for a count if missing. |
| **Network** | "search my connections", or implied by phrasing about your own network | Runs a one-shot LLM filter over the user's imported LinkedIn `Connections.csv`. Cheap, no web calls. |
| **Decision-makers** | "I want to sell X to Acme, map the buying committee" (single named company) | Fans out role-specific LinkedIn searches, classifies hits into committee roles (economic buyer / champion / technical evaluator / user / influencer / gatekeeper), writes a short narrative. |
| **Person background** | "tell me everything about <name> at <company>" | Fires several Tavily queries (posts, talks, papers, interviews), synthesises a citation-heavy HTML brief. |
| **Site scraper** | A URL or bare domain in the brief ("scrape acme.com") | Bounded same-origin crawl (≤30 pages, ≤2 hops, 8s/page, 200KB/page), then synthesises a structured brief. |
| **Enrich** | A list of names/emails/domains/LinkedIn URLs to verify | Apollo.io `/people/match` per identity, mapped into the prospect shape. |
| **Draft** | After selecting prospects → "Write outreach" | LLM-written email + LinkedIn DM per recipient, referencing one specific signal each. |
| **Discover more** | "Discover more" button after a Find result | Re-runs Find with the previous prospect names excluded, plus the original brief. |
| **Followup** | A question/refinement after a Find result ("only those with email", "which raised most recently") | LLM decides between answering in text or filtering the existing list down by id. |

CRM features: kanban + table views, drag-and-drop stage changes, bulk add from a Find result, shareable boards (revocable join tokens), one-click background-fill (Tavily research per contact), Apollo enrichment per board.

Auth: email/password, Google OAuth, opaque session cookie (`nm_session`). A dev-only mock auth (`VITE_MOCK_AUTH=1`) skips the backend entirely and uses localStorage so the UI works with no server running.

## Repo layout

```
.
├── client/     Vite + React + Tailwind SPA (DiscoverPage, CRM, Settings)
├── server/     Express API, Kysely migrations, Auth.js, AI mode handlers
├── shared/     Types shared between client and server (Prospect, CompletionResult, etc.)
├── legacy/     Original static HTML/JS app — kept for reference, served at /legacy in dev
├── DEPLOY.md   Railway / Render / Fly recipes
├── railway.json, render.yaml, server/fly.toml — platform configs
```

## Prerequisites

- Node ≥ 20
- Postgres 14+ (`brew install postgresql@16 && brew services start postgresql@16`, or a [Neon](https://neon.tech) free-tier database)
- At least one LLM key (OpenAI, Anthropic, or DeepSeek) and a Tavily key — either set as server env vars OR pasted by each user in Settings

## First-time setup

```bash
# 1. Install deps for all workspaces
npm install

# 2. Create the env file
cp .env.example .env
# Edit .env — set DATABASE_URL, AUTH_SECRET (openssl rand -hex 32),
# and at least one LLM key + TAVILY_API_KEY if you don't want to force BYOK.

# 3. Create the database
createdb network_map   # or point DATABASE_URL at any Postgres

# 4. Apply migrations
npm run migrate
```

If you want to poke at the UI without running the API at all, set `VITE_MOCK_AUTH=1` in `client/.env.local` — login accepts any email and the rest of the data is in localStorage.

## Run in dev

```bash
# Both at once (recommended):
npm run dev          # API on :4000, client on :5173

# Or in two terminals:
npm run dev:server   # API
npm run dev:client   # client
```

The client proxies `/api/*` to `:4000`, so cookies flow same-origin.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run client + server in parallel |
| `npm run dev:server` / `npm run dev:client` | Run one workspace |
| `npm run build` | Build `shared`, then `server`, then `client` |
| `npm run typecheck` | TS check across all workspaces |
| `npm run migrate` | Apply pending Kysely migrations |
| `npm run migrate:make <name>` | Scaffold a new migration file |
| `npm run --workspace=server migrate:down` | Roll back the last migration |

## Environment variables

See `.env.example` for the full list. The server reads:

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `AUTH_SECRET` | ≥32-char random secret (`openssl rand -hex 32`) |
| `SERVER_URL`, `CLIENT_URL` | Used for CORS + OAuth redirects |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional — Google OAuth |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY` | At least one needed for chat modes (unless every user is BYOK) |
| `TAVILY_API_KEY` | Web search (Find, decision-makers, person-background, site-scraper) |
| `APOLLO_API_KEY` | Optional — Apollo enrichment |

Client (Vite reads only `VITE_*`):

| Var | Purpose |
|---|---|
| `VITE_API_URL` | Empty in dev (uses Vite proxy); the API origin in prod |
| `VITE_MOCK_AUTH` | `1` to bypass the server entirely (localStorage-backed) |

## BYOK and key precedence

Each user can paste their own keys in **Settings → API keys** (stored in `localStorage`, never sent to the server's database). The client forwards them as `X-User-{Provider}-Key` headers; the server prefers a user-provided key over its own env var **and skips usage accounting** for that call. This means:

- A workspace can run on a single shared `OPENAI_API_KEY` / `TAVILY_API_KEY` set on the server, OR
- Every user can BYOK and the server doesn't need any LLM/Tavily keys at all.

The client sanitises keys before stuffing them into headers — it strips zero-width chars, NBSP, and rejects any key with non-ASCII chars (a re-paste from Notion/Slack often introduces smart quotes that would otherwise blow up `fetch()`).

## API surface

All routes are under `/api`. Auth is a session cookie set by `/api/auth/*`. Most routes require auth.

| Group | Routes |
|---|---|
| Auth | `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, Google OAuth at `/api/auth/google/*` |
| People (your imported connections) | `GET/POST /api/people`, `POST /api/people/bulk`, `GET/PATCH/DELETE /api/people/:id` |
| Chats + AI completion | `GET/POST /api/chats`, `GET/PATCH/DELETE /api/chats/:id`, `GET /api/chats/:id/messages`, `POST /api/chats/:id/completion` (typed dispatch on `mode`) |
| CRM boards | `GET/POST /api/crm/boards`, `PATCH/DELETE /api/crm/boards/:id`, `GET /api/crm/boards/:id/stream` (SSE) |
| CRM contacts | `GET/POST /api/crm/boards/:id/contacts`, `POST /api/crm/boards/:id/contacts/bulk`, `PATCH/DELETE /api/crm/contacts/:id` |
| CRM enrichment | `POST /api/crm/boards/:id/enrich` (Apollo per contact), `POST /api/crm/boards/:id/background` (Tavily background brief per contact) |
| Board sharing | `POST /api/crm/boards/:id/share`, `DELETE /api/crm/boards/:id/share`, `POST /api/crm/share/:token/join` |
| Apollo (direct) | `GET /api/apollo/status`, `POST /api/apollo/search`, `POST /api/apollo/match` |
| Usage | `GET /api/usage` (per-provider buckets) |
| Health | `GET /health` |

The completion endpoint flushes `200 OK` early and writes whitespace heartbeats every 10s so cloud proxies don't kill long Find runs. The client reads the body as text first, parses it as JSON, and surfaces a clear "server stopped responding" message if the body is empty (proxy timeout / restart).

## Costs and quotas

The chat tracks Tavily and LLM credit-exhaustion errors specifically. When a provider returns a quota or auth error mid-Find, the chat surfaces a styled card ("Tavily web-search credit limit reached — add your own key in Settings") instead of a misleading "no results found". This works for OpenAI / Anthropic / DeepSeek / Tavily.

## Deploy

See [DEPLOY.md](./DEPLOY.md) for Railway / Render / Fly recipes. The server's `Dockerfile` runs migrations on boot. Railway is the most-tested target.

## Limits and known sharp edges

- **Long Find runs.** Briefs with many firms × many titles can hit the cloud-proxy request cap (Railway/Render typically 120–300s). The client surfaces a clear timeout message; the workaround is to split the brief.
- **`Connections.csv` schema.** Network mode reads from the local `people` table — load it via Settings → Import LinkedIn Connections, or `POST /api/people/bulk`.
- **Apollo and Tavily are paid services.** A free Apollo tier exists; Tavily's free tier covers ~1k searches/mo. Set up BYOK for any user who'll run heavy briefs.
- **Mock-auth is dev-only.** `VITE_MOCK_AUTH=1` bypasses the server completely. Never set in production.
