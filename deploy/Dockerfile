# Snapshot — production image (UI + API + Playwright Chromium)
# Build from monorepo root:
#   docker build -f deploy/Dockerfile -t snapshot:latest .

ARG PLAYWRIGHT_VERSION=1.62.1

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CI=1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/replay/package.json packages/replay/

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY apps apps
COPY packages packages
COPY scripts scripts

RUN pnpm --filter @snapshot/core build \
  && pnpm --filter @snapshot/replay build \
  && pnpm --filter @snapshot/server build \
  && pnpm --filter @snapshot/web build

# --- runtime ---
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy AS runtime

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate \
  && apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PORT=8787
ENV HOST=0.0.0.0
ENV SNAPSHOT_DATA_DIR=/data
ENV SNAPSHOT_WEB_DIST=/app/apps/web/dist

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/replay/package.json packages/replay/

RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/replay/dist packages/replay/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY deploy/docker-entrypoint.sh /app/deploy/docker-entrypoint.sh

RUN chmod +x /app/deploy/docker-entrypoint.sh \
  && mkdir -p /data/jobs \
  && chown -R pwuser:pwuser /data /app

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/deploy/docker-entrypoint.sh"]
