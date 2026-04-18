# Client — build static bundle, serve with nginx.
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm install --workspaces --include-workspace-root

COPY shared ./shared
COPY client ./client
RUN npm run build --workspace=shared
# VITE_API_URL is baked in at build time; pass via --build-arg on Railway/Render.
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build --workspace=client

# --- Runtime ---
FROM nginx:alpine
COPY --from=build /app/client/dist /usr/share/nginx/html
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
