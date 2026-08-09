# mome — 构建镜像（可选）
# 本地 SQLite 数据卷挂到 /data/local.db，生产建议切 Turso（libsql://）

FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .
ENV NODE_ENV=production
RUN bun run build

FROM base AS release
COPY --from=prerelease /app/.output /app/.output
COPY --from=prerelease /app/drizzle /app/drizzle
COPY --from=prerelease /app/scripts/migrate.mjs /app/scripts/migrate.mjs
COPY package.json bun.lock /app/
RUN cd /app && bun install --production --frozen-lockfile
ENV NODE_ENV=production
ENV DATABASE_URL=file:/data/local.db
EXPOSE 3000
VOLUME ["/data"]
CMD ["/bin/sh", "-c", "bun /app/scripts/migrate.mjs && bun /app/.output/server/index.mjs"]
