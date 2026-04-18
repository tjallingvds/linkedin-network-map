# Server — Dockerfile for Railway / Render / Fly.
# Builds the shared types then the server. Runs migrations before starting.
FROM node:20-alpine AS base
WORKDIR /app

# Copy workspace manifests first for better layer caching.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

# Workspaces install — only production deps for the server, but we need
# dev deps during the build stage. Use a multi-stage to slim the runtime.
RUN npm install --workspaces --include-workspace-root

# --- Build stage ---
FROM base AS build
COPY shared ./shared
COPY server ./server
RUN npm run build --workspace=shared
RUN npm run build --workspace=server

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

WORKDIR /app/server

EXPOSE 4000
# Run migrations, then start the server.
CMD ["sh", "-c", "node dist/db/migrate.js up && node dist/index.js"]
