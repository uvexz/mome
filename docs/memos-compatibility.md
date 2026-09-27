# Memos 兼容矩阵

> 矩阵快照：2026-09-14，对齐 usememos/memos **v0.30.0** 的 proto 与 openapi。
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

| 入口                        | 认证方式                                                           | 说明                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/auth/signin`  | `{"passwordCredentials":{"username","password"}}`                  | 校验走 Better Auth（先用户名、失败且输入形如邮箱时回退邮箱登录），返回 Mome 签发的 HS256 access token。                             |
| `Authorization: Bearer ...` | access token（15 分钟）/ `memos_pat_…` / `mome_…`                  | access token 为 `BETTER_AUTH_SECRET` 派生的 HS256 JWT；PAT 与既有 API key 都查库哈希校验。                                          |
| cookie session              | Better Auth `HttpOnly` 会话 cookie                                 | 浏览器内已登录的会话可直接调用 `/api/v1/*`，无需另发 token。                                                                        |
| refresh                     | `memos_refresh` `HttpOnly` cookie（30 天，`Path=/`，SameSite=Lax） | `POST /api/v1/auth/refresh` 单次消费并轮换 refresh token、签发新 access token；`signout` 撤销该用户的 refresh token 并清除 cookie。 |

access/refresh token 不是上游 JWT 的字节级 parity（issuer 为 `mome`、密钥独立派生），
只保证客户端可用。refresh token 存储于服务端并在轮换、signout、会话撤销时失效；已签发的
stateless access JWT 不做即时撤销，登出或改密后仍可能在其 15 分钟有效期剩余时间内使用。
PAT 可单独撤销。

**写操作的来源校验**：带 cookie 的写请求必须来自可信 Origin（`BETTER_AUTH_URL`，
非生产环境额外放行 localhost）——SameSite=Lax 挡不住同站不同源页面发出的简单请求。
只有 `authenticate()` 实际采用的非空 Bearer 凭据可豁免来源检查：Bearer 不回落到 cookie，
即使令牌无效也直接 401；非 Bearer 或空 Bearer 会回退到 cookie session，因此仍须校验可信 Origin。
浏览器扩展（web-clipper 等）用 PAT 发请求时会一并带上目标站点的 cookie，正是这种形态。
`POST /api/v1/auth/refresh` 与 `signout` 只认 `memos_refresh` cookie，无条件要求可信
Origin——加一个 Authorization 头不会放宽它们。

## REST 矩阵

| 能力                           | 路径                                                                           | 状态     | 备注                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前用户                       | `GET /api/v1/auth/me`                                                          | 已实现   | 返回 `{user}`；`role` 由 `admin_users` 决定。                                                                                                                                                               |
| 登录 / 刷新 / 登出             | `POST /api/v1/auth/{signin,refresh,signout}`                                   | 已实现   | 见"认证边界"。                                                                                                                                                                                              |
| memo 列表                      | `GET /api/v1/memos`                                                            | 已实现   | `pageSize`/`pageToken`/`state`/`orderBy`/`filter`/`showDeleted`。                                                                                                                                           |
| memo 创建 / 详情 / 更新 / 删除 | `POST /api/v1/memos`、`GET/PATCH/DELETE /api/v1/memos/{memo}`                  | 已实现   | 支持 `memoId`、`createTime`、`updateMask`；删除是 Mome 的软删（进回收站）。                                                                                                                                 |
| 评论                           | `GET/POST /api/v1/memos/{memo}/comments`                                       | 部分实现 | Mome 评论不是独立 memo 行，按上游语义投影成带 `parent` 的 memo。                                                                                                                                            |
| 反应                           | `GET/POST /api/v1/memos/{memo}/reactions`、`DELETE …/{reaction}`               | 部分实现 | 只映射 👍（对应 Mome 点赞）；`reaction` 段是点赞者的 user id。                                                                                                                                              |
| 引用关系                       | `GET/PATCH /api/v1/memos/{memo}/relations`                                     | 部分实现 | 映射 `memo_links`（REFERENCE）；`PATCH` 全量替换，只能引用自己的 memo。                                                                                                                                     |
| 用户列表 / 详情 / 批量         | `GET /api/v1/users`、`GET /api/v1/users/{user}`、`POST /api/v1/users:batchGet` | 已实现   | 邮箱只对本人与管理员返回；`filter` 仅支持 `username == "…"`。                                                                                                                                               |
| 用户统计                       | `GET /api/v1/users/{user}:getStats`                                            | 部分实现 | `totalMemoCount`/`tagCount`/`memoCreatedTimestamps`/`pinnedMemos` 有值，memo 类型统计为 0。                                                                                                                 |
| PAT 管理                       | `GET/POST /api/v1/users/{user}/personalAccessTokens`、`DELETE …/{token}`       | 已实现   | 签发 `memos_pat_…`，明文只在创建响应出现一次；复用 `api_keys` 表。                                                                                                                                          |
| 用户设置                       | `GET /api/v1/users/{user}/settings`、`GET …/settings/{setting}`                | 部分实现 | 只认 `GENERAL`，`memoVisibility` 取站点级 `default_visibility`；Mome 无每用户语言/主题，字段省略。其他 setting id 返回 `NOT_FOUND`。                                                                        |
| 附件上传                       | `POST /api/v1/attachments`                                                     | 部分实现 | 图片直接进 S3（与编辑器上传同 key 布局、同配额）；返回 `attachments/{id}`、`externalLink`（对象公开地址）与 `createTime`，正文是唯一载体，随 CreateMemo 的 `attachments` 引用落成正文末尾的 Markdown 图片。 |
| 附件删除                       | `DELETE /api/v1/attachments/{attachment}`                                      | 部分实现 | 资源名尾段解回对象 key 并校验归属后删 S3 对象；幂等。Mome 没有附件表，因此不校验该对象是否被某条 memo 引用。                                                                                                |
| 实例信息                       | `GET /api/v1/instance/profile`                                                 | 部分实现 | `version` 固定为 `0.30.0`（对客户端声明上游 API 版本，供 0.26+ 版本门控）；`instanceUrl` 取 `BETTER_AUTH_URL`；`needsSetup` 按是否存在用户判断。                                                            |
| 标准错误                       | 所有端点                                                                       | 已实现   | `{code, message, details}`，code 为 gRPC 状态码（3/5/6/7/12/16…）。                                                                                                                                         |
| CORS                           | 所有端点                                                                       | 已实现   | `OPTIONS` 204 + `Access-Control-Allow-Origin: *`，响应 `Cache-Control: no-store`。                                                                                                                          |

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

### 兼容面放宽的输入口径

兼容层不是原样转发原生的输入限制：第三方客户端的载荷形态与 Mome 编辑器不同，
以下三处按客户端实测放宽，未放宽的部分保持与原生一致。

| 输入              | 原生 Mome / `/v1`         | `/api/v1/*` 兼容面                   | 原因                                                                                                                       |
| ----------------- | ------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| memo `content`    | ≤5000 字                  | ≤20000 字                            | 浏览器扩展把整页文章压成一条 memo，5000 字会让大量真实剪藏直接失败。代价：这类超长 memo 回到 Mome 编辑器保存前需要先裁剪。 |
| 客户端自带 memoId | 服务端生成 ULID           | `[A-Za-z0-9_-]`，总长 ≤36            | web-clipper 的回退 ID 形如 `legacy_1726…_ab12` / `clip_…`，含下划线；上游接受这类 ID。                                     |
| 附件单图          | ≤8MB，每人 30/时 + 100/日 | 同一上限与配额（另加全站 IP 300/时） | 上游 `CreateAttachment` 是 JSON base64，字节由服务端代传，其余（魔数校验、key、公开 URL）沿用原生逻辑。                    |

### 时间戳格式：必须不带小数秒

兼容层对外的时间戳一律走 `protoTimestamp()`（`src/server/memos-compat/json.ts`），
输出 `YYYY-MM-DDTHH:MM:SSZ`。**不要用 `Date.prototype.toISOString()`**：
它带 3 位小数秒，而 swift-openapi-runtime 的默认 `dateTranscoder` 是 `.iso8601`
（`ISO8601DateTranscoder()`，formatter 沿用 Foundation 默认的
`.withInternetDateTime`，不含 `.withFractionalSeconds`），解析带小数秒的字符串会
返回 nil 并抛 `DecodingError.dataCorrupted`，导致**整条响应**在客户端解码失败，
症状是 `Client encountered an error invoking the operation "…"`。

上游 Go 服务的 protojson 在秒的小数位为 0 时裁掉小数部分，Memos 自身也是秒精度，
所以这里按秒截断既兼容又与上游一致。入参方向的 `parseTimestamp()` 仍然宽容，
接受带小数秒的 RFC3339。

回归防护见 `memos-compat.test.ts` 的 `memos compat protojson timestamps`。

### 附件与正文的关系

Mome 没有 attachments 表：`POST /api/v1/attachments` 把图片写进 S3，
CreateMemo 里的 `attachments: [{name}]` 由兼容层解回对象 URL 并以 Markdown 图片
追加到正文末尾（`attachment.name` 是对象 key 的 base64url 封装，服务端据此校验归属）。
`DELETE /api/v1/attachments/{attachment}` 走同一条解析路径删掉 S3 对象。
因此：同一个附件名不能跨用户引用或删除（PERMISSION_DENIED），S3 未配置时上传与删除
都返回 `FAILED_PRECONDITION(9)` 而不是静默丢弃，列表 / 读取 / 绑定附件端点仍然未实现。

上传响应带 `externalLink`（对象公开地址，与正文里的 Markdown 图片同 URL）与
`createTime`。客户端（MoeMemos 等）优先用 `externalLink` 取图；缺了它就会回退拼
`{host}/file/{name}/{filename}`，而 Mome 不提供该路由，附件将无法显示。

## 映射边界

| 概念          | 上游                                  | Mome                                                                                                    |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 可见性        | `PRIVATE` / `PROTECTED` / `PUBLIC`    | 只有 `public` / `private`；`PROTECTED` 写入折叠为 private，读取不会返回 PROTECTED。                     |
| 状态          | `NORMAL` / `ARCHIVED`，删除是独立维度 | `archived` 布尔 + `deletedAt` 软删；软删会复位 `archived`。                                             |
| 置顶          | 可同时置顶多条                        | 每位用户只允许一条置顶 memo（数据库唯一索引），置顶新的会取消旧的。                                     |
| 标签          | 内容派生的扁平路径字符串              | 层级标签表；对外输出完整路径（如 `工作/项目`），过滤按完整路径精确匹配。                                |
| 评论          | 带 COMMENT relation 的独立 memo       | `memo_comments` 表，投影为带 `parent` 的 memo（不占用户 memo 列表）。                                   |
| 反应          | 任意 emoji                            | 只有 👍（点赞）；其他类型返回 UNIMPLEMENTED。                                                           |
| 附件          | `attachments` 资源 + `/file/...` 读取 | 无附件表：图片直接进 S3 并以 Markdown 落进正文；只实现了上传 + 随 CreateMemo 引用，其余附件端点未实现。 |
| memo 永久链接 | `/memos/{uid}`                        | 详情页是 `/@{username}/{id}`；`/memos/{id}` 作为兼容别名重定向过去（非公开/已归档只对作者解析成功）。   |
| 分享          | `MemoShare` + 不透明 token            | 无分享表；公开 memo 通过 `/@username/{id}` 访问，分享端点未实现。                                       |
| 位置 / 空间   | `location` / `space`                  | 无对应字段；`location` 写入被忽略。                                                                     |

## 明确未实现

以下端点按路径返回 `UNIMPLEMENTED(12)` / HTTP 501：

- `GET /api/v1/attachments`、`attachments:batchDelete`、`GET/PATCH attachments/{attachment}`、
  `memos/{memo}/attachments*`
  （附件只支持上传、删除与随 CreateMemo 引用，见"附件与正文的关系"）
- `memos/{memo}/shares*`、`shares/{shareToken}/memo`
- `memos/-/linkMetadata*`（Open Graph 抓取）
- `users:stats`、`users/{user}/settings/{setting}` 的 `PATCH`（`UpdateUserSetting`）、
  `users/{user}/webhooks*`、`users/{user}/notifications*`、`users/{user}/linkedIdentities*`、
  `users/{user}/shortcuts*`
- `identity-providers*`、`instance/settings*`、`instance/stats`
- `activities/*`、`/api/v1/sse`（第三方客户端会调用；见 memoflow 检查报告，
  客户端普遍只把 404/405 当作"服务器不支持"，501 在探测路径上是硬错误）
- 其他任何未列出的 `memos.api.v1` 方法

也不支持：Connect / protobuf / gRPC / gRPC-Web 传输（官方 Memos Web 依赖它）、
SSE（`/api/v1/sse`）、MCP、webhook 投递、AI transcription、多用户协作 ACL。

## 已对接客户端：usememos/web-clipper

对接对象是扩展商店里的 usememos/web-clipper（曾用本地克隆 `docs/web-clipper/` 逐端点
核对契约，克隆已移除）。它用 **Direct connection + PAT**（`memos_pat_…` 或 `mome_…`）连接，
请求面固定为：

| 客户端调用                                               | 兼容层行为                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /api/v1/instance/profile`                           | `version: "0.30.0"`，通过客户端 0.26.0+ 的门控                    |
| `GET /api/v1/auth/me`                                    | `{user:{name:"users/{id}",username,displayName}}`                 |
| `POST /api/v1/memos`（可选 `?memoId=`）                  | 接受 UUID 与 `legacy_*`/`clip_*`；`attachments` 落成正文 Markdown |
| `GET /api/v1/memos?pageSize=20&orderBy=create_time desc` | POST 响应丢失后的对账                                             |
| `POST /api/v1/attachments`                               | 图片上传，需要 S3 已配置                                          |
| `${instanceUrl}/memos/{id}`（浏览器打开）                | 由 `/memos/$memoId` 重定向到 `/@{username}/{id}`                  |

### 已修复：保存一律 403

扩展的 `fetch` 会带上目标站点的 cookie，而 Origin 是 `chrome-extension://…`。
兼容层原先对所有"带 cookie 的非 GET 请求"强制可信 Origin，于是保存
（`POST /memos`、`POST /attachments`）全部返回 403
`cookie 鉴权的写操作必须来自可信 Origin`，而连接探测（`GET /instance/profile`、
`GET /auth/me`）正常——症状正是"能保存实例地址与 token，但发布不了内容"。
见"认证边界"的写操作来源校验：带 Bearer 的请求跳过该检查，cookie-only 的
refresh/signout 仍严格校验。回归用例：`memos compat cookie write origin guard`。

已知边界（客户端侧行为，服务端不做特殊适配）：

- 图片以 Markdown 追加在正文末尾，客户端对账按"正文完全相等"匹配会因此失败。
  该路径只在 POST 响应丢失时触发，重试会撞上 `ALREADY_EXISTS(409)`——不会产生重复
  memo，但用户会看到一次保存失败。
- `PROTECTED` 写入折叠为 private；客户端本地历史仍显示 Protected。
- S3 未配置时附件上传返回 `FAILED_PRECONDITION(9)`，客户端把每张图计入 `failedImages`
  并继续保存纯文本 memo（文本剪藏不受影响）。
- 兼容层代传图片字节（扩展 → Mome → S3），比直传多一跳，慢网络下可能触发客户端 8s 超时。

## 已对接客户端：hzc073/memoflow

参考克隆在 `docs/memoflow/`（Flutter 客户端，支持 Memos API 0.21–0.29）。检查结论、
逐端点矩阵与待修问题见 [`docs/memoflow-compatibility.md`](./memoflow-compatibility.md)。
摘要：选 0.29.0 + PAT/密码可正常登录，memo 增删改查、评论、关系、统计可用；
点赞（客户端用 ❤️，本服务只认 👍）、给已有 memo 加图（附件 list/bind 未实现）、
通知、快捷键当前不可用，且
**客户端的能力探测只把 404/405 当作"服务器不支持"，501 是硬错误**——这是接入
新客户端时最需要注意的一条口径。

> 该报告写作时 `users/{user}/settings/GENERAL` 尚未实现，是 memoflow 首页 loading
> 卡住的原因之一；现已实现（见 REST 矩阵"用户设置"一行），该条待复测。

## 已对接客户端：mudkipme/MoeMemos

参考克隆在 `docs/MoeMemos/`（iOS 客户端，声明支持 Memos 0.27.0–0.30.0）。
逐端点矩阵、问题清单与修复记录见
[`docs/moememos-compatibility.md`](./moememos-compatibility.md)。摘要：版本探测与
PAT 鉴权可用；真正让登录失败的是**时间戳带毫秒**（P0-2）——客户端默认的 ISO8601 解码器不接受
小数秒，整条响应报废；`settings/GENERAL` 曾返回 501 是第二道坎（该调用没有 `try?`）。
两条都已修复，`CreateAttachment` 缺 `externalLink`、附件删除 501 也一并修掉。

## 仓库测试证据

- `src/server/memos-compat/memos-compat.test.ts`：51 个用例覆盖鉴权（PAT/JWT/cookie、
  登录失败）、写操作的 cookie 来源校验（Bearer 豁免与 cookie-only 端点）、memo CRUD 与
  `memoId`/`createTime`/`uid`、长正文、跨用户可见性隔离、
  CEL 子集与非法 filter/orderBy、分页游标、评论、反应、关系、附件上传与删除（含本地
  stub S3 的完整 PUT/DELETE 形状与正文引用）与引用校验、用户设置（`GENERAL` 与站点级
  默认可见性）、protojson 时间戳（递归扫描真实响应，禁止小数秒）、永久链接解析、
  用户与邮箱可见性、PAT 生命周期、实例信息、未实现端点与 CORS。
- 2026-09-14 本地 `bun run test`：84 个用例（6 个文件）全绿；`bun run typecheck`、
  `bun run lint`、`bun run check` 无告警。
- 2026-09-08 本地 `bun dev` + 真实 SQLite 的 HTTP smoke：匿名/鉴权读、创建/更新/评论/
  反应/PAT/统计/删除、`OPTIONS` 预检全部按预期返回（脚本用完即删，未留数据）。

这些是 Mome 自己的契约测试与本地 smoke，不等于第三方客户端已上线可用；接入某个具体
客户端时，请记录客户端版本、请求路径、认证方式与失败请求。
