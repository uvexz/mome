# MemoFlow 兼容性检查

> 快照：2026-09-14。服务端：本仓库 `/api/v1/*` Memos 兼容层（契约见
> [`docs/memos-compatibility.md`](./memos-compatibility.md)）。客户端：克隆在
> `docs/memoflow/` 的 [hzc073/memoflow](https://github.com/hzc073/memoflow)
> （commit `8298e9b`，公开版 Flutter 客户端，支持 Memos API 0.21–0.29）。
>
> 本页是**客户端接入实测报告**，不是兼容承诺。矩阵里的每一行都标注了证据等级：
> 「实测」= 用临时 replay 脚本打到真实 handler（见"验证方法"）；
> 「读码」= 仅由双方源码推断；
> 「机制实测」= 路径未单独跑，但同一套兜底（未在 ROUTES 中 → 通用 `UNIMPLEMENTED`/501）已在别的路径上实测过。

## 结论摘要

MemoFlow 可以连上 Mome 并完成日常记录：选 **0.29.0** 登录（PAT 或用户名密码）、
memo 增删改查、标签、置顶、归档、评论、关系、统计热力图都走本仓库已实现的路由。
但**点赞、给已有 memo 加图、通知、用户设置、快捷键**这几块目前不可用，
其中"用户设置"会在首次登录后让首页 loading 遮罩停住 30 秒，"附件"相关的 501
会让客户端 outbox 反复失败。

| 能力                             | 结论                                                                      | 证据            |
| -------------------------------- | ------------------------------------------------------------------------- | --------------- |
| PAT 登录 / 用户名密码登录        | 可用（须选 0.29.0；见"版本门控"）                                         | 实测            |
| memo 列表 / 详情 / 创建 / 编辑   | 可用                                                                      | 实测            |
| 归档、软删、回收站               | 可用（`force=true` 被忽略，见 P2-7）                                      | 实测            |
| 标签、置顶                       | 可用（Mome 每位用户只允许一条置顶）                                       | 实测            |
| 评论                             | 可用（`{memos,nextPageToken}` 形状匹配）                                  | 实测            |
| 关系列表 / 全量替换              | 可用                                                                      | 实测            |
| CreateMemo 里的 `relations`      | **被静默丢弃**                                                            | 实测            |
| 点赞（❤️）                       | **不可用**：本服务只接受 👍，返回 501                                     | 实测            |
| 图片上传 → **新建** memo         | 可用（需配置 S3；兼容层把附件落成正文 Markdown）                          | 实测            |
| 图片上传 → **已有** memo         | **不可用**：先 GET `memos/{uid}/attachments` → 501                        | 实测            |
| 附件读 / 删 / 绑定 / 列表        | **不可用**：全部 501                                                      | 实测            |
| 分享图片进 memo（share inline）  | **不可用**：客户端拼 `/file/attachments/{token}/{name}`，本服务没有该路由 | 读码            |
| 通知中心                         | **不可用**：`users/{user}/notifications`、`activities/*` 501              | 实测 / 读码     |
| 用户设置 GENERAL                 | **不可用**：501，且会卡住首页 loading（见 P0-2）                          | 读码 / 机制实测 |
| 快捷键 Shortcuts                 | **不可用**：`users/{user}/shortcuts` 501                                  | 读码 / 机制实测 |
| Webhook                          | 不可用：501（客户端只把 404/405 当"服务器不支持"）                        | 读码 / 机制实测 |
| SSE 实时刷新                     | 501 → 客户端静默关闭该功能（可接受）                                      | 读码 / 机制实测 |
| 服务端搜索 `content.contains` 等 | 可用                                                                      | 实测            |
| 搜索时间范围 `created_ts >= 秒`  | **静默失效**（秒被当成毫秒），靠客户端本地兜底                            | 实测            |
| 搜索 `creator_id` / `now()`      | 400 → 客户端回退本地过滤（可接受，但白跑一趟）                            | 实测            |
| 统计热力图                       | 可用（`memoCreatedTimestamps`）                                           | 实测            |
| 导入导出 / WebDAV / AI / 定位    | 与本服务无关（第三方服务或纯本地）                                        | 读码            |

## 一、版本门控：MemoFlow 只认 0.21–0.29

`MemoApiVersion` 只有 v021…v029，`parseMemoApiVersion()` 对 `0.30.0` 返回 null
（`docs/memoflow/memos_flutter_app/lib/data/api/memo_api_version.dart:37-57`）。
登录界面的版本下拉写死 `0.29.0 … 0.21.0`，默认取第一项 **0.29.0**
（`lib/features/auth/login_screen.dart:36-46,506-526`）。登录后版本被写进
`Account.serverVersionOverride`，运行期 API 严格锁在该版本
（`strictRouteLock: true`，`lib/data/api/memo_api_029.dart:19-59`），
取不到版本直接抛 `StateError`，不会降级。

因此各版本档位与本服务的实际关系是：

| 客户端选项          | 首个（也是唯一）当前用户路由        | 本服务        | 结果                      |
| ------------------- | ----------------------------------- | ------------- | ------------------------- |
| 0.29/0.28/0.27/0.26 | `GET /api/v1/auth/me`               | 已实现        | **可登录**（推荐 0.29.0） |
| 0.25                | `GET /api/v1/auth/sessions/current` | 未实现（501） | 登录失败                  |
| 0.24/0.23/0.22      | `POST /api/v1/auth/status`          | 未实现（501） | 登录失败                  |
| 0.21                | `POST /api/v2/auth/status`          | 未实现（501） | 登录失败                  |

注意 `getCurrentUser()` 只跑候选列表的第一项，其余 7 条路由是死代码
（`lib/data/api/memos_api/memos_api_auth.dart:6-10`），所以没有"换一个端点重试"的兜底。

另外 `GET /api/v1/instance/profile` 返回 `version: "0.30.0"`，超出客户端支持区间：

- 登录界面总是显式传版本，所以这条不影响主流程；
- 但 `_detectVersionFromBaseUrl()`（PAT 登录不带 override 时）会抛
  `Unsupported server version "0.30.0". Supported: 0.21.0~0.29.0.`
  （`lib/state/system/session_provider.dart:365-378`）；
- 设置页"检测实例信息"会把 `0.30.0` 写回账号档案，之后 `_resolveMemoApiVersionForAccount`
  解析不了 → `No fixed API version selected.`（同上 :584-594）。

## 二、逐端点矩阵（按 v0.29 profile 的调用）

### 认证与登录

| MemoFlow 调用                                      | 本服务行为                                                         | 影响                             |
| -------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------- |
| `POST /api/v1/auth/signin` `{passwordCredentials}` | 200 `{user, accessToken, accessTokenExpiresAt}`                    | 可用                             |
| `GET /api/v1/auth/me`                              | 200 `{user}`                                                       | 可用                             |
| `POST /api/v1/users/{id}/personalAccessTokens`     | 200 `{personalAccessToken, token}`（`expiresInDays:0` → 永不过期） | 密码登录用它换长期 PAT，实测通过 |
| `GET /api/v1/users/{id}/personalAccessTokens`      | 200 `{personalAccessTokens, nextPageToken}`                        | 可用                             |

客户端只需要 `user.name == "users/{id}"` 与 `token`（`memos_api_auth.dart:448-472`），
本服务两者都满足。注意 0.27+ 在 `_resolveUserName()` 里只有在 id 是**纯数字**时才走
`users/{username}`；Mome 的 id 非数字，因此仍然请求 `users/{id}`（`:336-353`）。

### memo 读写

| MemoFlow 调用                                                                      | 本服务行为                                                | 影响                                                   |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| `GET /api/v1/memos?pageSize=300&state=NORMAL\|ARCHIVED`                            | 200 `{memos,nextPageToken}`（无 `totalSize`，客户端兼容） | 可用                                                   |
| `POST /api/v1/memos?memoId=…` `{content,visibility,pinned,createTime,attachments}` | 200，附件落成正文末尾 Markdown                            | 可用                                                   |
| `POST /api/v1/memos`（body 里带 `relations`）                                      | 200，但 **`relations` 被忽略**                            | 组合创建时"关联 memo"丢失                              |
| `PATCH /api/v1/memos/{uid}?updateMask=content,pinned\|state\|visibility`           | 200                                                       | 可用                                                   |
| `PATCH …?updateMask=content,update_time`（带 `updateTime`）                        | 200，`updateTime` 被忽略                                  | 客户端本地时间与服务器不一致，无功能损失               |
| `PATCH …?updateMask=create_time,display_time`（0.26/0.27）                         | 200，两个字段都被忽略                                     | 修改创建时间/显示时间无效（Mome 无 display_time 概念） |
| `PATCH …?updateMask=…,location`（带 `location:null`）                              | 200，`location` 被忽略                                    | 无影响（Mome 无位置字段）                              |
| `GET /api/v1/memos/{uid}`                                                          | 200                                                       | 可用                                                   |
| `DELETE /api/v1/memos/{uid}` / `?force=true`                                       | 200（软删）；第二次调用 404                               | `force` 无效，"永久删除"只是再软删一次                 |

### 互动

| MemoFlow 调用                                              | 本服务行为                                           | 影响                                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/memos/{uid}/comments?pageSize=30&orderBy=…`   | 200 `{memos,nextPageToken}`                          | 可用（`orderBy` 被忽略，客户端本地排序）                                                                  |
| `POST /api/v1/memos/{uid}/comments` `{content,visibility}` | 200（带 `parent`）                                   | 可用                                                                                                      |
| `GET /api/v1/memos/{uid}/reactions`                        | 200 `{reactions,nextPageToken}`，`reactionType:"👍"` | 客户端只把 `❤️`/`HEART` 当点赞（`memo_engagement_provider.dart:761-764`），所以已有点赞不会显示为"我赞过" |
| `POST /api/v1/memos/{uid}/reactions` `reactionType:"❤️"`   | **501** `Mome 只支持 👍 反应`                        | **点赞完全不可用**                                                                                        |
| `DELETE /api/v1/memos/{uid}/reactions/{uid}`               | 200（reaction 名末段是点赞者 id）                    | 可用                                                                                                      |
| `GET /api/v1/memos/{uid}/relations`                        | 200 `{relations,nextPageToken}`                      | 可用                                                                                                      |
| `PATCH /api/v1/memos/{uid}/relations`                      | 200                                                  | 可用                                                                                                      |

### 附件

| MemoFlow 调用                                                  | 本服务行为                                                               | 影响                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `POST /api/v1/attachments?attachmentId=…`                      | 200 `{name,filename,type,size}`（`size` 是字符串，客户端 `_toInt` 能读） | 可用（S3 必须已配置，否则 400 FAILED_PRECONDITION）                   |
| `GET /api/v1/memos/{uid}/attachments?pageSize=1000`            | **501**                                                                  | 给**已有** memo 加图前的探测直接抛错（客户端只把 404/405 当"不支持"） |
| `PATCH /api/v1/memos/{uid}/attachments`                        | **501**                                                                  | 绑定失败 → outbox 任务失败重试                                        |
| `GET /api/v1/attachments/{uid}`                                | **501**                                                                  | 409 冲突恢复路径不可用                                                |
| `DELETE /api/v1/attachments/{uid}`                             | **501**                                                                  | 删除图片/清理失败上传时报错                                           |
| `GET /file/attachments/{token}/{filename}`（客户端按附件名拼） | 本服务无此路由                                                           | 分享图片进 memo 会写入一个坏链接                                      |

新建 memo 带图的路径是**可用**的：`_shouldBindAttachmentDuringCreateMemo()` 为真时
客户端跳过 list/bind，直接把附件名放进 CreateMemo，本服务把它落成
`![image](S3 公开 URL)`（实测正文为
`"hello from memoflow\n\n![image](https://cdn.example.com/mome/memo-image/…png)"`）。
代价与 web-clipper 相同：客户端本地正文与服务器正文因此不一致。

### 通知、设置、快捷键、SSE

| MemoFlow 调用                                            | 本服务行为 | 影响                                                      |
| -------------------------------------------------------- | ---------- | --------------------------------------------------------- |
| `GET /api/v1/users/{user}/notifications`                 | 501        | 通知中心不可用                                            |
| `GET /api/v1/activities/{id}`                            | 501        | 通知详情不可用                                            |
| `GET /api/v1/users/{id}/settings/GENERAL`                | 501        | 见 P0-2：首页 loading 不会自动消失；设置页报错            |
| `PATCH /api/v1/users/{id}/settings/GENERAL`              | 501        | 无法改服务端默认可见性                                    |
| `GET /api/v1/instance/settings/MEMO_RELATED`、`/STORAGE` | 501        | 客户端捕获后按"未知"处理，可接受                          |
| `GET /api/v1/users/{id}/shortcuts`                       | 501        | 快捷键设置页报错（列表页用 `valueOrNull` 容忍）           |
| `GET /api/v1/users/{id}/webhooks`                        | 501        | Webhook 页报错（客户端只把 404/405 显示成"服务器不支持"） |
| `GET /api/v1/sse`                                        | 501        | 客户端把 401/404/405/501 都当"不支持"，静默关闭实时刷新   |

### 搜索与 filter

实测（同一账号下三条不同创建时间的 memo）：

| filter 表达式                                                       | 本服务                        | 说明                                                       |
| ------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| `content.contains("alpha")`                                         | 200，命中 1 条                | 正确                                                       |
| `tag in ["smoke"]` / `tags.exists(t,t=="…")` / `"smoke" in tags`    | 200，命中 3 条                | 正确                                                       |
| `creator == "users/{id}"`                                           | 200，命中 3 条                | 正确                                                       |
| `visibility == "PRIVATE"` / `pinned` / `has_link` / `has_task_list` | 200                           | 正确                                                       |
| `created_ts >= 1767225600`（客户端实际发的形态）                    | 200，**命中 3 条**            | 单位错误：字面量按毫秒直接比 `timestamp_ms` 列，等于不过滤 |
| `created_ts >= timestamp(1767225600)`                               | 200，命中 1 条                | 正确（但客户端不发这个）                                   |
| `creator_id == 1`（客户端现代方言）                                 | **400** `未知字段 creator_id` | 客户端 400 兜底到本地过滤                                  |
| `created_ts >= now() - 86400`（快捷键生成）                         | **400** `不支持的函数 now()`  | 同上，本地兜底                                             |
| `content.matches("a.*")`、`space == "…"`                            | 400                           | 客户端兜底                                                 |

`created_ts` 那条最值得修：MemoFlow 从 `memo_search_coordinator` 发的是
**裸 epoch 秒**（`'created_ts >= $startTimeSec'`），本服务把它当毫秒，
于是"时间范围筛选"在服务端静默退化成全量扫描。因为客户端随后会本地
再过滤一遍（`_matchesRemoteSearchMemoLocally` 带 `startTimeSec`），**结果仍正确**，
只是每次都要拉全量分页。

## 三、必须修的问题（按影响排序）

### P0-1 未实现端点用 501，客户端的"能力探测"只认 404/405

客户端几乎所有的降级判断都是 `status == 404 || status == 405`，501 只在个别地方
被容忍（v0.22 grpc-web 回退、SSE）。本仓库的设计原则是"未实现返回
`UNIMPLEMENTED(12)`/501，绝不伪成功"，这个原则在 memoflow 上直接表现为
**硬失败**：附件探测/绑定/删除会让 outbox 任务反复重试，通知、快捷键、WebHook、
用户设置则是页面直接报错。

两个方向可选，需要产品取舍：

1. **补齐端点**（推荐给附件：`GET/DELETE /api/v1/attachments/{id}`、
   `GET/PATCH /api/v1/memos/{id}/attachments`）。Mome 没有附件表，但用
   "正文里的 Markdown 图片 + S3 key"已经能反解出附件列表，最小实现是可行的。
2. **对"客户端会探测"的端点返回 404**，让客户端自己降级。代价是放弃
   "未实现一律 501"的自我约束，需要同步改 `docs/memos-compatibility.md` 的口径。

### P0-2 `users/{user}/settings/GENERAL` 501 会让首页 loading 卡住

`home_screen.dart:289-321`：`allReady` 要求 `userGeneralSettingProvider.hasValue`，
而该 provider 直接 `GET api/v1/users/{id}/settings/GENERAL`
（`lib/state/settings/user_settings_provider.dart:9-17`），501 → provider 进 error →
`hasValue` 永远 false → 遮罩不会自动消失，只能等 30 秒后点"关闭"
（`home_screen.dart:38,123-129`）。遮罩只在"首次启动"出现（显示时就把
`homeInitialLoadingOverlayShown` 置真），所以影响是**首次进入首页白等 30 秒**，
外加设置页的"服务端设置"永远报错。最小修复：实现
`GET/PATCH users/{user}/settings/GENERAL`（返回
`{name, generalSetting:{locale,memoVisibility,theme}}` 即可）。

### P0-3 点赞反应字符不一致（❤️ vs 👍）

MemoFlow 全端用 `kMemoLikeReactionType = '❤️'`（`memo_engagement_provider.dart:13`，
分享页 `_likeReactionType = '❤️'`）。本服务只接受 `👍` 且回写 `👍`
（`handlers.ts:625-671`、`dto.ts:162-173`）。结果是：点赞按钮 501 报错，
历史点赞也不会被识别成"我赞过"。建议接受并回写 `❤️`（可同时兼容 👍），
或至少把 `reactionType` 原样回显客户端提交的字符。

### P1-4 `relations` 在 CreateMemo 里被丢弃

客户端在创建时就会带 `relations`（v0.26+，`create_memo_route_compatibility_test.dart`
明确断言），本服务 `memosCreate` 只读 `content/visibility/attachments/createTime/pinned`。
实测：创建后 `GET …/relations` 返回 `null`。修复点：`handlers.ts` 的 `memosCreate`
里复用 `relationsSet` 的逻辑（`memo_links`，只允许引用自己的 memo）。

### P1-5 分享图片会写入 `/file/attachments/...` 坏链接

`resolveShareInlineAttachmentRemoteUrl()` 在我们没有 `externalLink` 时按
`/file/attachments/{name}/{filename}` 拼 URL
（`lib/core/share_inline_image_content.dart:195-206`、`lib/core/attachment_url.dart:39-46`），
本服务没有这个路由。建议加一条 `GET /file/attachments/{token}[/{filename}]`
→ 302 到 S3 公开 URL（顺带解决任何按上游约定拼 `/file/` 的客户端）。

### P1-6 `created_ts` 裸数字的单位

见"搜索与 filter"。建议 CEL 里对 `created_ts`/`updated_ts` 与**裸整数字面量**比较时
按秒处理（`×1000`），或在解析层显式拒绝并要求 `timestamp()`——前者更兼容客户端，
后者更"不猜"。无论哪种，都不该静默按毫秒比。

### P2-7 `force=true` 永久删除被忽略

`memoDelete` 不看 `force`，永远软删。客户端回收站的"永久删除"因此不会真正清库，
第二次调用还会拿到 404（实测）。Mome 的回收站产品语义需要确认：如果 Mome 侧
本就有清空回收站，可以在 `force=true` 时走硬删。

### P2-8 `instance/profile.version = "0.30.0"` 超出客户端区间

见"版本门控"。若希望 memoflow 的自动探测/实例检测路径可用，把 `version` 报成
`0.29.0` 是把"上游 proto 对齐版本"换成"客户端可用版本"的取舍；也可两者都保留
（例如另加一个非标准字段 `compatVersion`），但那需要客户端识别，当前不会。

### P2-9 其他静默忽略

`update_time`、`create_time`、`display_time`、`location`、`visibilities`（复数）在
写入路径都被忽略而不报错。前三个会改变客户端本地时间与服务端时间的差异，
`display_time` 在 0.27 档还会让 `orderBy=display_time desc` 变 400（客户端本地兜底）。
如果 Mome 不打算支持 display_time，可以在 `updateMask` 里显式拒绝这些字段，
让客户端走它自己的"字段不支持"分支，而不是静默丢弃。

### P2-10 其他未实现但被客户端调用的面

`users/{user}/shortcuts`（增删改查）、`users/{user}/webhooks`（增删改查）、
`users/{user}/notifications`、`activities/{id}`、`instance/settings/*`。
按 P0-1 的选择决定是补齐还是改状态码。

## 四、客户端降级机制（决定"501 到底疼不疼"）

| 触发点                | 判定                                                         | 位置                                                                      |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 附件列表/绑定前置探测 | 404/405 → 视为不支持；否则 rethrow                           | `lib/state/memos/memos_remote_sync_attachments.part.dart:198-206,600-612` |
| 附件删除 outbox       | 404 → 视为已删；否则 rethrow                                 | 同上 `:618-628`                                                           |
| 父级列表查询回退      | 400/404/405                                                  | `memos_remote_sync_state_sync.part.dart:605-620`                          |
| creator filter 回退   | 400/500                                                      | 同上 `:625-645`                                                           |
| 搜索整体回退本地      | 任意异常 → "Search flow failed, fallback to local cache"     | `memo_search_coordinator.part.dart:361-375`                               |
| 快捷键 filter 回退    | 400/404/405/500                                              | `memos_search_providers.part.dart:469`                                    |
| v0.22 grpc-web 回退   | 404/405/501                                                  | `memos_api_memos.dart:827-840`                                            |
| SSE 视为不支持        | 401/404/405/501                                              | `memos_live_refresh_api.dart:240-242`                                     |
| 设置类端点            | 401/403 → 无权限，404/405 → 端点不可用，其余 → requestFailed | `memos_api_resources.dart:376-391`                                        |
| 快捷键/WebHook 设置页 | 404/405 → "服务器不支持"                                     | `shortcuts_settings_screen.dart:165`、`webhooks_settings_screen.dart:181` |
| 错误体                | 读 `message` → `error` → `detail`（**不读 `code`**）         | 多处，如 `memos_remote_sync_errors.part.dart:3-22`                        |

所以：**能让客户端降级的是 400/404/405（个别 500/501），501 在关键路径上是硬错误**。
好消息是本服务的中文 `message` 会被客户端原样展示，用户至少看得到原因。

## 五、验证方法

1. **本仓库契约测试**：`bun test ./src/server/memos-compat` → 37 pass（2026-09-14）。
2. **客户端契约测试**（作为"客户端要什么"的事实来源，本次未运行，机器上没有 Flutter）：
   `docs/memoflow/memos_flutter_app/test/data/api/`（`versioned_api_routes_integration_test.dart`、
   `create_memo_route_compatibility_test.dart`、`update_memo_route_compatibility_test.dart`、
   `attachment_upload_size_limit_test.dart` 等 9 个文件）。
3. **临时 replay 脚本**（本次写在 `smoke/memoflow-replay.test.ts`，用完已删）：
   用 `#/server/test-db` 的临时库 + 本地 stub S3，按 v0.29 profile 的真实顺序调用
   `handleMemosCompat`，覆盖：instance/profile → auth/me → 列表(NORMAL/ARCHIVED)
   → 附件上传 → 带 attachments 的 CreateMemo → 附件 list/bind/get/delete →
   PATCH(updateMask 各种组合) → 评论/反应/关系 → getStats → notifications →
   instance settings → delete(force) → 15 条 filter 方言 → 密码登录链路
   （signUpEmail → signin → 建 PAT → 用 PAT 拉 auth/me/PAT 列表）。
   本页所有标"实测"的结论都来自这一次运行，未改动 `local.db`。

## 六、接入建议（给使用者）

- MemoFlow 登录时把版本选成 **0.29.0**（默认值），用 PAT 或用户名密码都可以。
- 需要图片功能时给 Mome 配好 S3；新建 memo 带图可用，给已有 memo 补图不可用。
- 通知中心、用户设置、快捷键、WebHook、点赞这几块在当前兼容层下不可用，
  属已知边界而非配置问题。
