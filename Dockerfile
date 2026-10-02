# syntax=docker/dockerfile:1
# Multi-stage build: compile TypeScript with dev tooling, ship only production dependencies and dist/.
# Pinned to an exact Node patch release (package.json engines: >=22 <23).
ARG NODE_VERSION=22.23.3

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:${NODE_VERSION}-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
# dist/db/migrate.js resolves ../../migrations, i.e. /app/migrations.
COPY --chown=node:node migrations ./migrations
# Non-root runtime user (built into the official image).
USER node
EXPOSE 3000
# Liveness only (no dependency requirement). Uses Node's built-in fetch, so no curl/wget is needed.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Run node directly (not via npm) so SIGTERM reaches the process for graceful shutdown.
CMD ["node", "dist/server.js"]
