# Deployment

Three options are pre-configured. Pick one.

## Railway (recommended)

### 1. Provision

1. Push this repo to GitHub.
2. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** → select this repo. Railway reads `railway.json` and builds the **server** from `server/Dockerfile`.
3. In the same project: **+ New → Database → PostgreSQL**.

### 2. Configure the API service

On the app service → **Variables**, set:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference, not a copy) |
| `AUTH_SECRET` | output of `openssl rand -hex 32` (≥ 32 chars) |
| `NODE_ENV` | `production` |
| `PORT` | `4000` |
| `SERVER_URL` | your Railway API domain, e.g. `https://network-map-api.up.railway.app` |
| `CLIENT_URL` | your client domain (set after step 3, then redeploy) |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` | at least one, for the chat modes |
| `TAVILY_API_KEY` | for web search during enrichment |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | only if using Google OAuth |
| `APOLLO_API_KEY` | only if using Apollo enrichment |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | only if using billing |
| `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_GROWTH` / `STRIPE_PRICE_SCALE` | one Stripe price ID per credit pack |

Under **Settings → Networking**, click **Generate Domain** to get the public API URL — use that as `SERVER_URL`.

Migrations run automatically on each boot (`CMD` in `server/Dockerfile` runs `migrate.js up` before `index.js`).

### 3. Deploy the client as a second service

1. In the same project: **+ New → GitHub Repo → this repo** again (Railway lets one repo power multiple services).
2. On the new service → **Settings → Build**, set **Dockerfile Path** to `client/Dockerfile` and **Root Directory** to repo root (the Dockerfile needs access to `shared/` and `client/`).
3. **Variables**:
   - Add a **Build Arg** (not a runtime var): `VITE_API_URL=https://<api-domain>` from step 2.
4. **Generate Domain**, then go back to the API service and set `CLIENT_URL` to this domain. Redeploy the API service so CORS picks up the new origin.

### 4. Finish

- Add `https://<server-url>/api/auth/google/callback` to the Google Console OAuth redirect URIs (if using Google sign-in).
- Add `https://<server-url>/api/billing/webhook` as a Stripe webhook endpoint (if using billing) and copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
- Verify `https://<server-url>/health` returns `{"ok":true}`.

## Render (Blueprint)

```bash
# Push to GitHub, then:
#   Render Dashboard → New → Blueprint → select this repo
```

`render.yaml` provisions: web API, web client, Postgres DB. Fill in the `sync: false` vars in the dashboard after the first deploy.

## Fly.io

```bash
# From repo root:
fly launch --no-deploy --copy-config --config server/fly.toml
fly postgres create
fly postgres attach <db-app-name>
fly secrets set \
  AUTH_SECRET=$(openssl rand -hex 32) \
  SERVER_URL=https://<api>.fly.dev \
  CLIENT_URL=https://<web>.fly.dev \
  OPENAI_API_KEY=... \
  ANTHROPIC_API_KEY=... \
  TAVILY_API_KEY=...
fly deploy --config server/fly.toml
```

Deploy the client separately (Fly + nginx Dockerfile, or Vercel/Netlify static).

---

## After deploy checklist

- [ ] `https://<server>/health` returns `{"ok":true}`
- [ ] Sign up with email+password works
- [ ] Session cookie is set (DevTools → Application → Cookies → `nm_session`)
- [ ] Google OAuth callback URL is whitelisted in Google Console
- [ ] Stripe webhook URL configured (`https://<server>/api/billing/webhook`) if using billing

## Environment variable reference

See [`.env.example`](./.env.example). `AUTH_SECRET` **must** be at least 32 chars.
