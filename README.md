![mome](https://raw.githubusercontent.com/uvexz/mome/refs/heads/main/public/android-chrome-192x192.png)

# mome

mome 是一个极简的 memos 网页应用（灵感来自 [flomo](https://flomoapp.com) / [usememos](https://www.usememos.com)），快速记录碎片想法。

## 技术栈

| 领域   | 选型                                                                               |
| ------ | ---------------------------------------------------------------------------------- |
| 框架   | TanStack Start（file-router）+ Nitro                                               |
| 样式   | Tailwind CSS v4（CSS-first，令牌在 `src/styles.css` 的 `@theme`）                  |
| 组件   | `@cloudflare/kumo`（Base UI）                                                      |
| 数据库 | SQLite via `@libsql/client` + Drizzle ORM（本地 `file:` / 生产 Turso `libsql://`） |
| 认证   | better-auth + drizzleAdapter                                                       |

## 快速开始

```bash
bun install

# 1. 配置环境变量
cp .env.example .env.local
# 编辑 .env.local，生成 BETTER_AUTH_SECRET：
bunx --bun @better-auth/cli secret

# 2. 初始化数据库（生成迁移 + 执行）
bun run db:generate
bun run db:migrate

# 3. 启动开发服务器（:3000）
bun dev
```
