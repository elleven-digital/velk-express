# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# The lockfile is written by npm 11; the npm 10 bundled with node:22 rejects it as out of sync.
RUN npm install -g npm@11.19.1 && npm ci

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build needs network access: next/font downloads the Geist font files.
RUN mkdir -p public && npm run build && npm run build:boot && npm run build:cli

FROM node:22-alpine AS runtime
LABEL org.opencontainers.image.source="https://github.com/elleven-digital/velk-express" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.title="Velk Express" \
      org.opencontainers.image.description="Self-hosted, open-source support panel for web agencies: client requests, tasks and communication in one place."
# PostgreSQL client tools for the pre-migration backup. Version: 18 (postgresql18-client)
# (the newest Alpine package; pg_dump must be at least the server's major, and the
# compose stack runs postgres:17).
RUN apk add --no-cache tini su-exec postgresql18-client \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist/boot.mjs ./dist/boot.mjs
COPY --from=build --chown=node:node /app/dist/cli.mjs ./dist/cli.mjs
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --chown=node:node docker/entrypoint.sh /app/entrypoint.sh
COPY docker/velk /usr/local/bin/velk
RUN chmod +x /app/entrypoint.sh /usr/local/bin/velk
# Starts as root only to fix ownership of DATA_DIR, then drops to the node user (see entrypoint.sh).
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/entrypoint.sh"]
