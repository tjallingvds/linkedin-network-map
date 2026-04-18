# Server — Dockerfile for Railway / Render / Fly.
# Builds shared + server + client into one image so a single Railway service
# serves the API and the SPA from the same origin. Runs migrations on boot.
FROM node:20-alpine AS base
WORKDIR /app

# Copy workspace manifests first for better layer caching.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

# Workspaces install — dev deps needed during build, slimmed in runtime stage.
RUN npm install --workspaces --include-workspace-root

# --- Build stage ---
FROM base AS build
COPY shared ./shared
COPY server ./server
COPY client ./client
RUN npm run build --workspace=shared
RUN npm run build --workspace=server
# Same-origin: VITE_API_URL left empty so the client uses relative paths.
ENV VITE_API_URL=
RUN npm run build --workspace=client

# --- Runtime stage ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
# Only install runtime deps (workspaces aware).
RUN npm install --workspaces --omit=dev --include-workspace-root

COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/shared/src ./shared/src
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist

WORKDIR /app/server

EXPOSE 4000
# Run migrations, then start the server.
CMD ["sh", "-c", "node dist/db/migrate.js up && node dist/index.js"]
