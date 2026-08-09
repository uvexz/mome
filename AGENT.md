# AGENT.md — mome

极简 memos 应用（类 flomo / usememos）：快速记录碎片想法，单栏时间线。

> 总是使用 bun 作为包管理器

## 技术栈

- **框架**：TanStack Start（file-router，`src/routes/`）+ Nitro + Vite 8 · React 19 · TypeScript strict
- **样式**：Tailwind CSS v4（CSS-first，令牌只写 `src/styles.css` 的 `@theme`，**不要创建 `tailwind.config.js`**）
- **组件**：`@cloudflare/kumo`（基于 Base UI）——**kumo 有的组件必须用 kumo**（`@cloudflare/kumo/components/*`）；缺失的组合件用 Base UI（`@cloudflare/kumo/primitives/*`）或原生元素 + Tailwind 实现
- **数据库**：SQLite via `@libsql/client` + Drizzle ORM。本地 `file:`、生产 Turso `libsql:`，**禁止 better-sqlite3 专属 API**
- **认证**：better-auth + drizzleAdapter（`src/lib/auth.ts`，处理器在 `src/routes/api/auth/$.ts`）
- **校验**：zod，所有 server function 必须有 `.validator()`
- **包管理/运行时**：bun

## 常用命令

```bash
bun dev                 # 开发服务器 :3000
bun run build           # 生产构建（.output/）
bun run typecheck       # TypeScript 类型检查（tsc --noEmit）
bun run lint            # ESLint
bun run format          # Prettier + eslint --fix
bun run db:generate     # schema 变更后生成迁移
bun run db:migrate      # 执行迁移（libsql，兼容 file:/libsql:）
bun run db:studio       # Drizzle Studio
bun run test            # hashtags 单测（vitest）
bun run test:integration # 数据层集成测试（scripts/integration-test.ts）
bun run e2e             # 浏览器端到端测试（scripts/e2e.mjs，需 dev server）
```

`src/routeTree.gen.ts` 由插件自动生成，**不要手改**。

## 架构约定

- 路径别名：`#/*` → `./src/*`
- 数据读写一律走 `createServerFn`（`src/server/`），GET 取数 / POST 变更；认证用 `src/server/middleware.ts` 的 authMiddleware（未登录 `throw redirect({ to: '/login' })`）
- 路由级守卫用 `beforeLoad`；筛选状态放 URL search params（`?tag= ?q= ?filter=`），保持类型安全
- server function 返回值必须可序列化；不允许闭包捕获客户端变量
- 纯逻辑（如 `#标签` 解析 `src/lib/hashtags.ts`）保持无依赖、配 vitest 单测
- 数据模型：better-auth 四表 + `memos` / `tags` / `memo_tags`；标签由 content 解析并在同一事务同步

## 设计规范（Vercel/Geist × Kumo，写 UI 代码前必读）

布局：单栏 `max-w-[640px] mx-auto`；粘性顶栏以 `border-b border-kumo-line` 分隔。

硬性规则：

1. 正文/控件文字 14px；≥16px 仅限标题
2. 标题 sentence case；禁用 `font-bold`（标题 `font-semibold`、行内 `font-medium`）；禁用 `tracking-*`
3. hover 变色必须即时，**禁止 `transition-colors`**
4. 用 `ring ring-kumo-line`，禁止 border + shadow 叠加；阴影克制
5. 相邻嵌套圆角保持同心：外半径 = 内半径 + padding
6. 相关文字间距小于外部间距（内 `gap-1.5` / 外 `gap-6`）；卡片 `px-5 py-4` 视觉对齐
7. 行内图标：`h-lh flex items-center` 对齐首行；行内 code 字号 `text-[0.9em]`
8. Dialog 用 `open` 属性控制，**禁止条件渲染**；LayerCard 不嵌套
9. 颜色用 `@theme` 中的 OKLCH 灰阶令牌 + 单一强调色；字体 Geist Sans / Geist Mono

## 环境变量

`.env.local`（勿提交）：`DATABASE_URL`、`DATABASE_AUTH_TOKEN`（远端可选）、`BETTER_AUTH_URL`、`BETTER_AUTH_SECRET`。
另有可选 `ADMIN_TOKEN`：站点无管理员时，已登录用户访问 `/admin` 输入该令牌成为首位管理员。

## 编码风格

- Prettier + `@tanstack/eslint-config`；提交前跑 `bun run format`
- 命名：组件文件 kebab-case，导出 PascalCase；server function camelCase
- 提交信息简洁、祈使句，可使用中文

---

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
