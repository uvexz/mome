# mome — 构建镜像（可选）
# 本地 SQLite 数据卷挂到 /data/local.db，生产建议切 Turso（libsql://）
# 基础镜像固定到与本地 bun 一致的确切版本，保证构建可复现

FROM oven/bun:1.3.14 AS base
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

# 非 root 运行：应用与数据卷归 app 用户所有
RUN useradd --uid 10001 --user-group --create-home app \
  && mkdir -p /data \
  && chown -R app:app /app /data

ENV NODE_ENV=production
ENV DATABASE_URL=file:/data/local.db
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/bin/sh", "-c", "bun -e \"fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\""]

USER app
CMD ["/bin/sh", "-c", "bun /app/scripts/migrate.mjs && bun /app/.output/server/index.mjs"]
