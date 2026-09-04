# syntax=docker/dockerfile:1
#
# Colonize API image.
#
# Build context is the *repository root* (an npm workspace: packages/shared + backend), so the
# shared contract package is compiled from source rather than fetched from a registry.
#
#   docker build -f docker/Dockerfile -t colonize-api .
#
# Stages: deps → build → prune dev deps → slim runtime as a non-root user.

ARG NODE_VERSION=20.18.0

# ---------------------------------------------------------------------------
# 1. dependencies — cached until a package.json or the lockfile changes
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY backend/package.json backend/

# Full install (not --omit=dev): the build stage needs typescript. No --ignore-scripts, so any
# dependency that compiles a native binding is built against this exact base image.
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# 2. build — shared first, because the backend type-checks against its emitted dist
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY packages/ packages/
COPY backend/ backend/

RUN npm run build -w @colonize/shared \
 && npm run build -w @colonize/backend

# Drop the toolchain: the runtime only executes compiled JS.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# 3. runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0

# The API is the only thing that runs here: no shell tooling, no build chain, no source.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist

# backend/.runtime holds uploaded files (LOCAL_STORAGE_DIR) and must survive a restart;
# docker-compose mounts a named volume here.
RUN mkdir -p /app/backend/.runtime/storage \
 && useradd --create-home --uid 1001 --shell /usr/sbin/nologin colonize \
 && chown -R colonize:colonize /app
USER colonize

EXPOSE 4000

# Readiness, not just liveness: /api/health/ready fails when MongoDB or Redis is unreachable,
# so an orchestrator will not route traffic to a container that cannot serve a tenant.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/dist/server.js"]
