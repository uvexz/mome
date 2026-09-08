# Memos 兼容矩阵

> 矩阵快照：2026-09-08，对齐 usememos/memos **v0.30.0** 的 proto 与 openapi。
> 本页描述 Mome 对外暴露的 Memos 兼容边界，不是"完整 Memos Server parity"的承诺。

Mome 是运行在 TanStack Start / Nitro 上的个人 memo 应用，不是 Memos Server 的 Go fork。
它的定位是"内核不同、对外协议尽量兼容"：应用层使用 Better Auth，数据由 libSQL/Turso +
Drizzle 承载，`/api/v1/*` 提供 Memos v1 的 **REST JSON** 兼容面（camelCase、
`google.rpc.Status` 错误体、AIP-160 风格的 `filter`/`orderBy`）。

兼容层的目标是让第三方 Memos REST 客户端（移动端 App、浏览器扩展、脚本、MCP 工具等）
可以连上 Mome。**官方 Memos Web 不在兼容范围内**：它走 Connect binary protobuf，
本仓库未实现 protobuf/gRPC-Web 编解码。

## 状态定义

| 状态     | 含义                                                           |
| -------- | -------------------------------------------------------------- |
| 已实现   | 存在对应 handler；不代表所有字段、错误、ACL 与上游逐字节一致。 |
| 已测试   | `memos-compat.test.ts` 或 HTTP smoke 对该路径有断言。          |
| 部分实现 | 资源存在但语义被折叠到 Mome 的模型上，差异见"映射边界"。       |
| 未实现   | 明确返回 `UNIMPLEMENTED(12)` / HTTP 501，不做伪成功。          |

## 认证边界

Better Auth 是应用层身份事实源；Memos 兼容层在其上做凭据 facade。

| 入口                        | 认证方式                                                           | 说明                                                                                                    |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/auth/signin`  | `{"passwordCredentials":{"username","password"}}`                  | 校验走 Better Auth（先用户名、失败且输入形如邮箱时回退邮箱登录），返回 Mome 签发的 HS256 access token。 |
| `Authorization: Bearer ...` | access token（15 分钟）/ `memos_pat_…` / `mome_…`                  | access token 为 `BETTER_AUTH_SECRET` 派生的 HS256 JWT；PAT 与既有 API key 都查库哈希校验。              |
| cookie session              | Better Auth `HttpOnly` 会话 cookie                                 | 浏览器内已登录的会话可直接调用 `/api/v1/*`，无需另发 token。                                            |
| refresh                     | `memos_refresh` `HttpOnly` cookie（30 天，`Path=/`，SameSite=Lax） | `POST /api/v1/auth/refresh` 轮换 cookie 并签发新 access token；`signout` 清除 cookie。                  |

access/refresh token 不是上游 JWT 的字节级 parity（issuer 为 `mome`、密钥独立派生），
只保证客户端可用。token 无服务端吊销列表：signout 只清 cookie，PAT 可单独撤销。

## REST 矩阵

| 能力                           | 路径                                                                           | 状态     | 备注                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------- |
| 当前用户                       | `GET /api/v1/auth/me`                                                          | 已实现   | 返回 `{user}`；`role` 由 `admin_users` 决定。                                                  |
| 登录 / 刷新 / 登出             | `POST /api/v1/auth/{signin,refresh,signout}`                                   | 已实现   | 见"认证边界"。                                                                                 |
| memo 列表                      | `GET /api/v1/memos`                                                            | 已实现   | `pageSize`/`pageToken`/`state`/`orderBy`/`filter`/`showDeleted`。                              |
| memo 创建 / 详情 / 更新 / 删除 | `POST /api/v1/memos`、`GET/PATCH/DELETE /api/v1/memos/{memo}`                  | 已实现   | 支持 `memoId`、`createTime`、`updateMask`；删除是 Mome 的软删（进回收站）。                    |
| 评论                           | `GET/POST /api/v1/memos/{memo}/comments`                                       | 部分实现 | Mome 评论不是独立 memo 行，按上游语义投影成带 `parent` 的 memo。                               |
| 反应                           | `GET/POST /api/v1/memos/{memo}/reactions`、`DELETE …/{reaction}`               | 部分实现 | 只映射 👍（对应 Mome 点赞）；`reaction` 段是点赞者的 user id。                                 |
| 引用关系                       | `GET/PATCH /api/v1/memos/{memo}/relations`                                     | 部分实现 | 映射 `memo_links`（REFERENCE）；`PATCH` 全量替换，只能引用自己的 memo。                        |
| 用户列表 / 详情 / 批量         | `GET /api/v1/users`、`GET /api/v1/users/{user}`、`POST /api/v1/users:batchGet` | 已实现   | 邮箱只对本人与管理员返回；`filter` 仅支持 `username == "…"`。                                  |
| 用户统计                       | `GET /api/v1/users/{user}:getStats`                                            | 部分实现 | `totalMemoCount`/`tagCount`/`memoCreatedTimestamps`/`pinnedMemos` 有值，memo 类型统计为 0。    |
| PAT 管理                       | `GET/POST /api/v1/users/{user}/personalAccessTokens`、`DELETE …/{token}`       | 已实现   | 签发 `memos_pat_…`，明文只在创建响应出现一次；复用 `api_keys` 表。                             |
| 实例信息                       | `GET /api/v1/instance/profile`                                                 | 部分实现 | `version` 固定为 `mome`；`instanceUrl` 取 `BETTER_AUTH_URL`；`needsSetup` 按是否存在用户判断。 |
| 标准错误                       | 所有端点                                                                       | 已实现   | `{code, message, details}`，code 为 gRPC 状态码（3/5/6/7/12/16…）。                            |
| CORS                           | 所有端点                                                                       | 已实现   | `OPTIONS` 204 + `Access-Control-Allow-Origin: *`，响应 `Cache-Control: no-store`。             |

### filter / orderBy 边界

兼容层不解释任意 CEL，只支持官方客户端实际发送的形态，未支持的语法返回
`INVALID_ARGUMENT(3)`，绝不静默忽略条件：

```text
content.contains("…") / content.startsWith("…") / content.endsWith("…")
creator == "users/…"          visibility == "PUBLIC" / visibility in ["PUBLIC","PRIVATE"]
pinned / pinned == true       tag in ["a","b"] / "a" in tags / tags.exists(t, t == "a")
tags.exists(t, t.startsWith("a"))
created_ts >= timestamp(1704067200)   updated_ts < now - duration("1h")
size(content) > 100           has_link / has_task_list / has_code / has_incomplete_tasks
&&  ||  !  与括号
```

`orderBy` 支持 `pinned` / `create_time` / `update_time` / `name` 的 `asc`/`desc`，
可逗号组合（如 `pinned desc, create_time desc`）；默认 `create_time desc`。

未支持：`content.matches()`（RE2，避免 ReDoS）、宏、字段间比较、`space`、
`has_location` 恒为 false、完整 AIP-160 分页语义。

## 映射边界

| 概念        | 上游                                  | Mome                                                                                |
| ----------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| 可见性      | `PRIVATE` / `PROTECTED` / `PUBLIC`    | 只有 `public` / `private`；`PROTECTED` 写入折叠为 private，读取不会返回 PROTECTED。 |
| 状态        | `NORMAL` / `ARCHIVED`，删除是独立维度 | `archived` 布尔 + `deletedAt` 软删；软删会复位 `archived`。                         |
| 置顶        | 可同时置顶多条                        | 每位用户只允许一条置顶 memo（数据库唯一索引），置顶新的会取消旧的。                 |
| 标签        | 内容派生的扁平路径字符串              | 层级标签表；对外输出完整路径（如 `工作/项目`），过滤按完整路径精确匹配。            |
| 评论        | 带 COMMENT relation 的独立 memo       | `memo_comments` 表，投影为带 `parent` 的 memo（不占用户 memo 列表）。               |
| 反应        | 任意 emoji                            | 只有 👍（点赞）；其他类型返回 UNIMPLEMENTED。                                       |
| 附件        | `attachments` 资源 + `/file/...` 读取 | 无附件表（图片直接进 S3 并以 Markdown 链接落进正文），资源未实现。                  |
| 分享        | `MemoShare` + 不透明 token            | 无分享表；公开 memo 通过 `/@username/{id}` 访问，分享端点未实现。                   |
| 位置 / 空间 | `location` / `space`                  | 无对应字段；`location` 写入被忽略。                                                 |

## 明确未实现

以下端点按路径返回 `UNIMPLEMENTED(12)` / HTTP 501：

- `attachments*`（含 `attachments:batchDelete`、`memos/{memo}/attachments`）
- `memos/{memo}/shares*`、`shares/{shareToken}/memo`
- `memos/-/linkMetadata*`（Open Graph 抓取）
- `users:stats`、`users/{user}/settings*`、`users/{user}/webhooks*`、
  `users/{user}/notifications*`、`users/{user}/linkedIdentities*`
- `identity-providers*`、`instance/settings*`、`instance/stats`
- 其他任何未列出的 `memos.api.v1` 方法

也不支持：Connect / protobuf / gRPC / gRPC-Web 传输（官方 Memos Web 依赖它）、
SSE（`/api/v1/sse`）、MCP、webhook 投递、AI transcription、多用户协作 ACL。

## 仓库测试证据

- `src/server/memos-compat/memos-compat.test.ts`：23 个用例覆盖鉴权（PAT/JWT/cookie、
  登录失败）、memo CRUD 与 `memoId`/`createTime`、跨用户可见性隔离、CEL 子集与非法
  filter/orderBy、分页游标、评论、反应、关系、用户与邮箱可见性、PAT 生命周期、
  实例信息、未实现端点与 CORS。
- 2026-09-08 本地 `bun dev` + 真实 SQLite 的 HTTP smoke：匿名/鉴权读、创建/更新/评论/
  反应/PAT/统计/删除、`OPTIONS` 预检全部按预期返回（脚本用完即删，未留数据）。

这些是 Mome 自己的契约测试与本地 smoke，不等于第三方客户端已上线可用；接入某个具体
客户端时，请记录客户端版本、请求路径、认证方式与失败请求。
