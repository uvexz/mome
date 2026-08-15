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

## 部署

Nitro 默认 `node-server` preset，普通平台使用标准构建产物：

```bash
bun run build
node .output/server/index.mjs
```

- 平台预设：`vercel` / `cloudflare-pages` 等在 `vite.config.ts` 的 `nitro({ preset })` 中切换
- 生产数据库建议用 Turso（`libsql://`），避免本地文件持久化问题
- Docker 使用 `bun run build:docker`，将迁移脚本打包进 `.output/` 并在启动时自动执行
- 可选 `Dockerfile` 数据卷挂载 `/data/local.db`

## 生产部署注意事项（安全相关，必读）

- **`BETTER_AUTH_URL` 必填且必须是 `https://` 公开地址**：缺失或写成 http 时应用会拒绝启动；它是会话 Origin 校验与 passkey RP 的唯一依据。
- **`NODE_ENV=production` 必须显式设置**：better-auth 的限流、会话 Secure cookie、dev 工具门控（`/api/dev-otp`）都依赖它；未设置时限流与门控会退化。
- **反向代理必须覆写 `X-Forwarded-For`**（如 nginx `proxy_set_header X-Forwarded-For $remote_addr;`）：应用限流从该头末跳取客户端 IP，追加模式（nginx 默认 `$proxy_add_x_forwarded_for`）可被伪造头绕过限流。
- **多实例部署时限流会失效**：内置限流为进程内存实现（单实例设计），多副本/Serverless 请替换为共享存储（Redis）或网关层限流。
- **S3 桶建议配置生命周期策略**：上传对象不会随 memo/头像删除而清理，建议对 `mome/` 前缀设置生命周期规则控制存储成本。
- **`ADMIN_TOKEN` 用 `openssl rand -base64 32` 生成**（≥128 位熵），首个管理员诞生后即可移除该环境变量。

## 部署至 PaaS

部署至 PaaS 平台可以参考： https://nitro.build/deploy
