# MoeMemos 兼容性检查

> 快照：2026-09-14。服务端：本仓库 `/api/v1/*` Memos 兼容层（契约见
> [`docs/memos-compatibility.md`](./memos-compatibility.md)）。客户端：克隆在
> `docs/MoeMemos/` 的 [mudkipme/MoeMemos](https://github.com/mudkipme/MoeMemos)
> （commit `7e9e8d6`，声明支持 Memos **0.27.0 – 0.30.0**；V0 旧线最低 0.21.0）。
>
> 本页是**客户端接入实测报告**，不是兼容承诺。矩阵里每一行都标注证据等级：
> 「实测」= 临时探针脚本打到真实 handler（见"验证方法"）；
> 「读码」= 仅由双方源码推断；
> 「实测 / 读码」= 响应形状实测、影响面由源码推断。

## 结论摘要

> **修复状态（2026-09-14 更新）**：P0-1 / **P0-2** / P1-1 / P1-2 已实现并加了契约测试，
> 见[第八节 修复记录](#八修复记录)。本节以下内容保留为**修复前**的实测快照。
>
> **P0-2 是用户实测报错后补查出来的**，第一版审计漏了它——见下方 P0-2 一节。

**修复前 MoeMemos 连不上 Mome：登录必定失败。**

客户端 `getCurrentUser()` 在拿到 `auth/me` 之后，还会无条件调用
`GET /api/v1/users/{user}/settings/GENERAL`（读默认可见性/主题）；本服务对该路径返回
`501 UNIMPLEMENTED`，而客户端这一句**没有** `try?`——异常直接冒泡到登录流程，
`loginMemosV1` 抛出、界面弹错误 toast，账号建不起来。这是唯一的硬阻断（P0-1）。

还有一条必须知道的数据安全坑：**给「已有」memo 加图会静默丢失**（P1-4，尚未修复）。

把 P0-1 补上之后，MoeMemos 的主要面是可用的：版本探测、PAT 鉴权、memo 列表 / 详情 /
新建 / 编辑 / 归档 / 软删、标签、热力图统计、附件上传 + 随新建 memo 落正文，以及客户端
实际发送的 `creator == "users/…"`、`visibility in ["PUBLIC","PROTECTED"]` 过滤
（**实测生效**，不是静默忽略）。

| 能力                                  | 修复前                                               | 证据        |
| ------------------------------------- | ---------------------------------------------------- | ----------- |
| 版本探测（自动选 V1）                 | 路由可用，但响应解码失败（P0-2）→ 已修复             | 实测        |
| PAT 登录（host + access token）       | **不可用**：P0-2 解码失败 + P0-1 501 → 均已修复      | 实测        |
| memo 列表 / 详情 / 新建 / 删除        | 可用                                                 | 实测        |
| memo 编辑（正文 / 可见性 / 置顶）     | 可用                                                 | 实测        |
| memo 归档 / 恢复                      | 可用                                                 | 实测        |
| 客户端 filter（creator / visibility） | 可用（已核对不是静默忽略）                           | 实测        |
| 标签（`getStats.tagCount`）           | 可用（map 形状正确）                                 | 实测        |
| 统计热力图                            | 可用（但字段名与 spec 不符，见 P2-2）                | 实测 / 读码 |
| 附件上传 → **新建** memo              | 可用（需 S3）；返回缺 `externalLink`（P1-1）→ 已修复 | 实测 / 读码 |
| 图片上传 → **已有** memo              | **静默丢失**：UpdateMemo 丢弃 `attachments`（P1-4）  | 读码        |
| 附件读 / 删                           | **不可用**：501（P1-2）→ 删除已修复，读取仍 501      | 实测        |
| memo 的 `attachments` 字段            | 恒为空 → 本地资源被摘链（P1-3）                      | 实测 / 读码 |
| 非图片附件（PDF / 视频 / 大图）       | **不可用**：服务端只收 5 种图片且 ≤8MB（P1-5）       | 读码        |
| 可见性 "Protected"（本地可见）        | **静默降级为 Private**（P1-6）                       | 读码        |
| 用户头像                              | 降级为默认头像（P2-3）                               | 读码        |
| widget / App Intent                   | 与本服务无关（只读本地 SwiftData）                   | 读码        |
| 分享扩展                              | 走 `createResource`，受 P1-1 / P1-2 / P1-5 限制      | 读码        |
| 密码登录 / 刷新 token                 | 客户端不使用（登录 UI 只有 host + token）            | 读码        |
| V0 旧线                               | 不适用：版本探测已正确判成 V1，见第一节（P2-5）      | 实测        |

## 一、版本探测：正确判成 V1，且恰好命中支持上限

`detectMemosVersion(hostURL:)` 的顺序是**先试 V0、再试 V1**
（`docs/MoeMemos/Packages/Account/Sources/Account/AccountUtils.swift:45-58`）：

| 步骤 | 客户端请求                      | 本服务  | 结果                                    |
| ---- | ------------------------------- | ------- | --------------------------------------- |
| 1    | `GET /api/v1/status`（V0 探测） | **501** | `try?` 吞掉 → `nil`，继续下一步（实测） |
| 2    | `GET /api/v1/instance/profile`  | **200** | `version: "0.30.0"` → `.v1("0.30.0")`   |

两步都用**完全无凭据**的请求实测过（这正是客户端的真实形态：版本探测跑在登录之前）：

```
无凭据 GET /api/v1/status           → HTTP 501  {"code":12,…}
无凭据 GET /api/v1/instance/profile → HTTP 200  {"version":"0.30.0","demo":false,…}
无凭据 GET /api/v1/auth/me          → HTTP 401  {"code":16,…}   ← 探测不会碰这条
```

第 2 步匿名可达是因为兼容层 `instanceProfile` 不调用 `authenticate`
（`handlers.ts:933`）。

版本判定落在 `evaluateMemosVersionCompatibility`：
`minimumV1 = 0.27.0`、`maximumV1 = 0.30.0`
（`Packages/Models/Sources/Models/SupportedMemosVersion.swift:12-13`），
`0.30.0` **恰好等于上限** → `.supported`，不弹"更高版本"确认框。

两个值得记下的边界：

- 版本号是写死的 `handlers.ts:943`（`version: '0.30.0'`）。上游再发 0.31 时，
  客户端会判成 `v1HigherThanSupported` 并弹确认框——只是警告，仍可"仍然登录"，
  不是硬错误（`AddMemosAccountView.swift:101-104`）。
- 因为第 1 步已经失败，V0 那套 `/api/v1/memo`、`/api/v1/resource`、`/api/v1/tag`、
  `/api/v1/user/me`、`/api/v1/memo/all` 全部是死路径，本服务不需要实现。
  **但这也意味着 `/api/v1/status` 绝不能返回 200**：一旦返回带非空 `profile.version`
  的响应，客户端会切到 V0 分支，而 V0 面本服务是空的，反而彻底不可用。

## 二、认证：PAT 直连，登录接口是死代码

MoeMemos 的登录界面只有 **host + access token**（`AddMemosAccountView.swift:41-52`），
没有用户名密码输入；全仓库 grep 不到任何 `signin` 调用。所以：

- `POST /api/v1/auth/{signin,refresh,signout}` 对 MoeMemos **完全不被调用**，
  兼容层这三个 handler 是为别的客户端（web-clipper、脚本）准备的。
- 实际走的是 `Authorization: Bearer <accessToken>`
  （`Packages/Services/Sources/ServiceUtils/Auth.swift:26-32`），
  即 `memos_pat_…` / `mome_…` PAT，由 `compat/auth.ts` 的 `authenticate()` 查库校验。
  这条路 **实测可用**。
- MoeMemos 会处理 `401/403` → `accessTokenExpired`
  （`MemosV1Service.swift:227-233`），兼容层的 `UNAUTHENTICATED(16)` → HTTP 401 对得上。

## 三、逐操作矩阵

MoeMemos 的 V1 请求面是封闭的：全仓库只有 **12 个** 不同的
`client.<Operation>` 调用（`MemosV1Service.swift`），下表就是全集。

| #   | MoeMemos 调用                        | HTTP 路径                                     | 本服务    | 结论                                                            |
| --- | ------------------------------------ | --------------------------------------------- | --------- | --------------------------------------------------------------- |
| 1   | `InstanceService_GetInstanceProfile` | `GET /api/v1/instance/profile`                | 200       | 可用（匿名可达）                                                |
| 2   | `AuthService_GetCurrentUser`         | `GET /api/v1/auth/me`                         | 200       | 可用，`{user:{…}}` 结构匹配 `json.user?.value1`                 |
| 3   | `UserService_GetUserSetting`         | `GET /api/v1/users/{user}/settings/{setting}` | **501**   | **P0-1 登录失败**                                               |
| 4   | `MemoService_ListMemos`（NORMAL）    | `GET /api/v1/memos`                           | 200       | 可用                                                            |
| 5   | `MemoService_ListMemos`（ARCHIVED）  | `GET /api/v1/memos`                           | 200       | 可用                                                            |
| 6   | `MemoService_ListMemos`（workspace） | `GET /api/v1/memos`                           | 200       | 可用（`visibility in [...]` 实测生效）                          |
| 7   | `MemoService_CreateMemo`             | `POST /api/v1/memos`                          | 200       | 可用；`attachments` → 正文末尾 Markdown                         |
| 8   | `MemoService_UpdateMemo`（编辑）     | `PATCH /api/v1/memos/{memo}`                  | 200       | 正文/可见性/置顶可用；**`attachments` 被丢弃**（P1-4）          |
| 9   | `MemoService_UpdateMemo`（归档）     | `PATCH /api/v1/memos/{memo}`                  | 200       | 可用（仅 `{state}`，无正文）                                    |
| 10  | `MemoService_UpdateMemo`（恢复）     | `PATCH /api/v1/memos/{memo}`                  | 200       | 可用                                                            |
| 11  | `MemoService_DeleteMemo`             | `DELETE /api/v1/memos/{memo}`                 | 200       | 可用（软删 = 回收站）                                           |
| 12  | `UserService_GetUser`                | `GET /api/v1/users/{user}`                    | 200       | 可用（workspace 列表补 creator 信息）                           |
| 13  | `UserService_GetUserStats`           | `GET /api/v1/users/{user}:getStats`           | 200       | 可用；`tagCount` 是 map ✅（P2-1/P2-2 字段名小疵）              |
| 14  | `AttachmentService_CreateAttachment` | `POST /api/v1/attachments`                    | 200 / 400 | 上传可用，**返回缺 `externalLink`**（P1-1）                     |
| 15  | `AttachmentService_ListAttachments`  | `GET /api/v1/attachments`                     | **501**   | 同步路径不调用；`MemosV1Service.listResources()` 会失败（P2-4） |
| 16  | `AttachmentService_DeleteAttachment` | `DELETE /api/v1/attachments/{attachment}`     | **501**   | **删除图片永久静默失败**（P1-2）                                |

`UserService_GetUserStats` 与 `AttachmentService_CreateAttachment` 一行对应两处调用点，
故 12 个 operation 展开成 16 行请求。

## 四、问题清单

### P0-1 `settings/GENERAL` 返回 501，登录链路直接断掉

> **已修复**（见[第八节](#八修复记录)）。以下为修复前的证据与当时的建议。

**证据链（全实测）**

1. 客户端：`MemosV1Service.swift:235-239`

   ```swift
   guard let name = user.name else { throw MoeMemosError.unsupportedVersion }
   let userSettingResp = try await client.UserService_GetUserSetting(
       path: .init(user: getId(remoteId: name), setting: "GENERAL"))
   let setting = try userSettingResp.ok.body.json   // ← 没有 try?
   ```

2. 调用方：`AccountViewModel.swift:70-77` 的 `loginMemosV1()` → `getCurrentUser()`；
   `AddMemosAccountView.swift:93-109` 的 `handleLoginTap()` 捕获后弹错误 toast。

3. 服务端：`handlers.ts:1045` 的 `UNIMPLEMENTED` 表只登记了
   `['users', ':user', 'settings']`（三段），**没有**登记四段的
   `/settings/{setting}`，于是落到 `handlers.ts:1119-1122` 的兜底分支。

4. 探针实测：

   ```
   GET /api/v1/users/probe-owner/settings/GENERAL
   → HTTP 501  {"code":12,"message":"… 不在 Mome 的 Memos 兼容范围内","details":[]}
   ```

**影响面**：登录失败；即使绕过登录，下面三处也会各自再打同一个接口并失败：

- `SyncingRemoteService.sync()` 第一步 `syncCurrentUserStrict()`
  （`SyncingRemoteService.swift:406-408,493-497`）→ **同步整体失败**；
- `Account.toUser()`（`Account.swift:53-63`）→ 账号详情页 `MemosAccountView`
  拿不到昵称/邮箱/头像；
- `SyncingRemoteService.getCurrentUser()` 在本地无缓存时会走远端
  （`SyncingRemoteService.swift:340-351`）。

**修复建议**（改动很小，登记两条路由即可）

```ts
// handlers.ts —— 新增 handler
const userSettingGet: Handler = async ({ request, params }) => {
  const actor = await requireActor(request)
  await limitRead(actor)
  const userId = params.user
  await loadUserRow(userId)
  // 与其他用户类端点同口径：只放本人与管理员
  if (userId !== actor.id && !actor.isAdmin) {
    throw new MemosError(Code.PERMISSION_DENIED, '只能查看自己的设置')
  }
  const setting = (params.setting ?? '').toUpperCase()
  if (setting !== 'GENERAL') {
    throw new MemosError(Code.NOT_FOUND, `设置 ${params.setting} 不存在`)
  }
  const site = await loadSiteSettings() // #/server/settings-core
  return memosJson({
    name: `users/${userId}/settings/GENERAL`,
    generalSetting: {
      // Mome 的默认可见性是站点级（site_settings.default_visibility），
      // 没有每用户值；proto3 JSON 省略 locale / theme 等价于默认值，
      // 客户端会退回 .private 而不会解不出来。
      memoVisibility:
        site.defaultVisibility === 'public' ? 'PUBLIC' : 'PRIVATE',
    },
  })
}
```

路由表加 `{ method: 'GET', pattern: ['users', ':user', 'settings', ':setting'], handler: userSettingGet }`，
并把 `UNIMPLEMENTED` 里的 `['users', ':user', 'settings']` 换成同样实现
（`ListUserSettings` 返回 `{settings:[…], nextPageToken: ''}`，
schema 见 `docs/MoeMemos/.../openapi.yaml:1028-1037`；顺带解决 memoflow 报告里的同类问题）。

### P0-2 时间戳带毫秒 → 客户端整条响应解码失败（**实际把登录打死的就是这条**）

> **已修复**（见[第八节](#八修复记录)）。这条是第一版审计**漏掉**的：当时只核对了字段
> 是否存在、类型是否是 string，没有把响应真的喂给客户端用的解码器。用户实测报错后补查。

**用户报错原文**

```
Client encountered an error invoking the operation
"InstanceService_GetInstanceProfile", caused by "Unknown", underlying error:
未能读取数据，因为它的格式不正确。
```

**根因链（逐环都已验证）**

1. 报错文案出自 swift-openapi-runtime 的 `ClientError.errorDescription`
   （`Sources/OpenAPIRuntime/Errors/ClientError.swift:134`）。
2. `caused by "Unknown"` 只在 `UniversalClient.swift:118-124` 出现，条件是
   **错误不是 `RuntimeError`**。所以这不是 Content-Type 不匹配、也不是状态码问题，
   而是一个裸的解码错误。
3. `underlying error: 数据格式不正确` 是 `DecodingError.dataCorrupted` 桥接成
   `NSCocoaErrorDomain` 后的文案。
4. 该 `DecodingError` 的确切来源是 `ISO8601DateTranscoder.decode`
   （`Sources/OpenAPIRuntime/Conversion/Configuration.swift:64-70`）：
   `ISO8601DateFormatter.date(from:)` 返回 nil 就抛 `dataCorrupted`。
5. 而 MoeMemos 用的是默认配置（`MemosV1Service.swift:29-36` 只传
   `serverURL/transport/middlewares`，没有自定义 `Configuration`），
   默认 `dateTranscoder` 是 `.iso8601`，即 `ISO8601DateTranscoder()`，
   它的 formatter **沿用 Foundation 默认的 `.withInternetDateTime`，不含
   `.withFractionalSeconds`**。
6. Mome 之前用 `Date.prototype.toISOString()` 输出 `2026-08-08T12:39:43.541Z`，
   带着 3 位小数秒 → formatter 直接返回 nil。

**本机实测（Swift 6.4 + Foundation，直接复刻 runtime 的 formatter 配置）**

```
default formatOptions: 1907                 (.withInternetDateTime)
  .withFractionalSeconds = 2048             (不在默认值里)
2026-08-08T12:39:43.541Z -> nil  <-- FAILS   ← Mome 当时输出
2026-08-08T12:39:43Z     -> 2026-08-08 12:39:43 +0000   ← 上游 memos 输出
localizedDescription = "The data couldn't be read because it isn't in the correct format."
```

最后一行与用户看到的中文文案逐字对应。

**为什么偏偏炸在 `InstanceService_GetInstanceProfile`**：`InstanceProfile` 里唯一的
非字符串字段就是 `admin`（`User`）的 `createTime` / `updateTime`。而它在**版本探测**
阶段就被调用——登录之前，所以用户感知为"登录报错"。`auth/me`、`ListMemos` 等所有带
时间戳的响应都会同样炸。

**为什么上游 memos 没事**：Go 的 protojson 在秒的小数位为 0 时会裁掉小数部分，
而 memos 的时间戳本身就是秒精度，所以客户端只在 Mome 上炸。

**修复**：新增 `protoTimestamp()`（`src/server/memos-compat/json.ts`），统一输出
protojson 形态 `YYYY-MM-DDTHH:MM:SSZ`，并把兼容层里**全部** 13 处
`toISOString()` 换成它（`dto.ts` 8 处、`handlers.ts` 3 处、`attachments.ts` 1 处、
`auth.ts` 1 处）。**任何新增的对外时间戳都必须走这个函数**，
`memos compat protojson timestamps` 测试会递归扫描真实响应，防止回归。

### P1-1 CreateAttachment 响应缺 `externalLink`，客户端拼出本服务不存在的 URL

> **已修复**（见[第八节](#八修复记录)）。

**证据**

- 兼容层只返回四个字段（`handlers.ts:750-756` → `attachments.ts:206-211`）：
  `{ name, filename, type, size }`，**没有 `externalLink`、没有 `createTime`**。
- 客户端 `Ext.swift:33-38`：

  ```swift
  if let externalLink, !externalLink.isEmpty, let url = URL(string: externalLink) { return url }
  return hostURL.appending(path: "file").appending(path: name ?? "").appending(path: filename ?? "")
  ```

- 于是回退 URL 变成 `{host}/file/attachments/<base64url token>/a.png`。
  本仓库 `src/routes/` 下**没有 `file` 路由**（`ls src/routes`、
  `grep /file src/routeTree.gen.ts` 均无命中），该请求只会 404。
  （MoeMemos V0 线用的是 `/o/r/{uid}`，本服务同样没有。）
- 这个坏 URL 会被**写进客户端本地库**
  （`SyncingRemoteService.swift:758-759`：`local.urlString = remoteResource.url.absoluteString`），
  之后所有远端下载都失败。实际受影响的调用点是
  `SyncingRemoteService.ensureLocalResourceFile`（`:353-397`，`:369` 调
  `remote.download`），以及它的 UI 入口：
  `Packages/MemoKit/.../Components/Attachment.swift:38`、
  `ResourceCard.swift:45`、app 侧 `MemoCardImageView.swift:68,115`。
  表现是附件缩略图 / 图片画廊打不开（正文里的 Markdown 图片走的是 S3 直链，不受影响）。

**修复建议**：`createAttachmentForUser` 返回里补
`externalLink: s3ObjectPublicUrl(s3, key)`（`#/server/s3` 已有此函数）与
`createTime: new Date().toISOString()`。客户端 `download` 只在 host 相同才加
Authorization（`ServiceUtils/Auth.swift:38`），S3 公读桶可直接下载；这一步同时让
P1-3 的反查有了稳定的 URL 前缀。

### P1-2 `DELETE /api/v1/attachments/{attachment}` 501 → 删除图片永久静默失败

> **已修复**（见[第八节](#八修复记录)）。

**证据**

- `handlers.ts:1035` 把该路径登记为 `UNIMPLEMENTED`（探针实测 501）。
- 客户端有两处删除并且都**吞掉异常**：
  `SyncingRemoteService.swift:322-338`（`catch { return }`）与 `:469-485`
  （`catch { continue }`）。
- 结果：本地行永远停在 `pendingDelete`，每次同步重试、每次失败，S3 对象永不回收，
  用户界面上"删掉的图"还在。

**修复建议**：真正实现它。资源名是对象 key 的 base64url 封装，`attachments.ts` 里已有
`attachmentObjectKey()` 可复用做「格式校验 + 归属校验」，删除动作就是一次
`DeleteObjectCommand`。不建议返回假的 200——那与本仓库"不做伪成功"的口径冲突。

### P1-3 `Memo.attachments` 恒为空 → 客户端把已同步的图片从 memo 上摘链

**证据**

- `dto.ts:102-138` 的 `memoJson` 不输出 `attachments` 字段（proto 里它是
  `Memo.attachments`，`openapi.yaml:1060-1125`）。实测 `POST /api/v1/memos` 响应里没有该键。
- 客户端 `LocalStore.reconcileResources`（`LocalStore.swift:286-306`）：

  ```swift
  let desiredRemoteIds = Set(resources.compactMap(\.remoteId))   // 恒为空集
  for stored in existing {
      if let id = stored.serverId, desiredRemoteIds.contains(id) { continue }
      if preserveLocalOnly, stored.serverId == nil { continue }   // 只保 local-only
      stored.memo = nil                                           // ← 已上传的资源被摘掉
  }
  ```

  新建 memo 后 `reconcileServerCreatedMemo`（`LocalStore.swift:177-205`）会走这段，
  于是刚上传的图片在本地被从 memo 上摘下来（图片本身仍以 Markdown 存在于正文里，
  所以"图还能看见"，但资源卡片 / 资源管理视图会丢）。

- 副作用：`memoEquivalent`（`SyncingRemoteService.swift:603-619`）比较
  `resourceSignature`，远端恒为 `[]`，所以**含图 memo 永远判为"不等价"**，
  每次同步都走一遍 apply / push 分支。

**修复建议**：让 `memoJson` 输出 `attachments`。无需新表——CreateMemo 已经把
`attachments` 落成正文末尾的 `![image]({s3PublicUrl}/mome/memo-image/{userId}/{ulid}.{ext})`，
读取时按该 URL 前缀反查正文里的图片即可投影出
`{ name: attachments/<base64url(key)>, filename, type, size, externalLink }`。
做 P1-1 之后 `externalLink` 与正文 URL 是同一个值，反查是可靠的。

### P1-4 `PATCH /api/v1/memos/{memo}` 丢弃 `attachments` → 给已有 memo 加图静默丢失

**证据**

- 客户端 `updateMemo` **每次**都带 `attachments`
  （`MemosV1Service.swift:145-159`），由 `ensureUploadedResources` 填
  （`SyncingRemoteService.swift:712-742`）。
- 兼容层 `memoPatch`（`handlers.ts:476-528`）只处理
  `content` / `visibility` / `pinned` / `state` 四个字段，
  `memos-core.patchMemoForUser` 的 patch 类型也只有这四个
  （`src/server/memos-core.ts:637-645`）——**没有 `attachments` 分支**。
- 对比 `memosCreate`（`handlers.ts:435-440`）是调用
  `attachmentImageMarkdown()` 把附件追加到正文的：**只有 create 路径有这段逻辑**。
- 结果：对已有 memo 加图，图片进了 S3，但既不进正文也不进附件列表 —— 服务端零痕迹，
  是一次静默数据丢失（只留下孤儿对象）。

**修复建议**：把 create 路径的 `attachmentImageMarkdown()` 复用到 patch：
计算「请求里的附件」−「当前正文里已引用的附件 URL」的差集，只把差集追加到正文末尾
（MoeMemos 每次下发全量列表，无脑追加会重复堆图）。同时补一个
「请求列表里没有、正文里还在」的移除分支，或明确只做追加（更保守，避免误删用户手写的图片链接）。

### P1-5 非图片附件一律被拒，且容量口径相差 128 倍

- 兼容层走 `resolveImageUpload`，只接受 PNG / JPEG / GIF / WebP / AVIF
  （`attachments.ts:109-125` + `#/lib/upload`），上限 `MEMO_IMAGE_MAX_BYTES = 8MB`
  （`src/server/s3.ts:14`）。
- 客户端编辑器 / 分享扩展 / App Intent 的本地预检上限是 **1 GiB**
  （`MemoEditorViewModel.swift:13`、`ShareViewController.swift:19`、`SaveMemoIntent.swift:15`），
  且分享扩展可以分享 PDF / zip / 视频等任意文件类型。
- 结果：分享一个 PDF 或一段视频 → 服务端 `INVALID_ARGUMENT(3)`，
  客户端 `pushLocalResourceCreate` 抛错被 `catch { return }` 吞掉，
  用户只看到"没上传成功"。

**结论**：这是产品范围差异，不是 bug。要么在客户端能力范围内使用（只分享图片、≤8MB），
要么把 `docs/memos-compatibility.md` 里"附件"一行显式写成"仅图片"。

### P1-6 `PROTECTED` 被静默折叠成 `private`，而客户端的可见性选择器提供该档

- 客户端两个 service 都对外声明 `[.private, .local, .public]`
  （`MemosV1Service.swift:39-41`），直接驱动编辑器里的可见性选择器
  （`Packages/MemoKit/Sources/MemoKit/Editor/MemoEditor.swift:355`）。
  `.local` 在 `Ext.swift:63-72` 映射成 `PROTECTED`。
- 兼容层写入侧把 `PROTECTED` 和 `PRIVATE` **一起**折叠成 `private`
  （`dto.ts:49-52`），读取侧永远不会输出 `PROTECTED`（`dto.ts:33-35`）；
  native `/v1` 也只接受 `'public' | 'private'`（`src/routes/v1/memos.ts:18`）。
- 后果：用户选 "Protected" → 服务端按 private 存 → 回读变成 "Private"，
  **全程无报错**，客户端 `reconcileServerCreatedMemo` 会把本地值也覆盖成 private，
  所以用户看不到任何提示。另外 Explore 的
  `visibility in ["PUBLIC","PROTECTED"]`（`MemosV1Service.swift:74`）永远匹配不到
  PROTECTED 行——这是**功能性的**，不只是标签写错。
- 方向上是收紧（更私密）而非泄露，所以不是安全问题。
- 没有任何能力协商端点，MoeMemos 无法得知本服务缺少 PROTECTED 档。
  要么实现一个"登录用户可读"档，要么接受这个静默降级并在本文档登记。

### P2 级

| 编号 | 问题                                                                                                                                                                                                | 证据                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| P2-1 | `getStats` 返回 `name: "users/{id}/stats"`，proto 规定是 `users/{id}`；客户端当前不读该字段，仅不符规范                                                                                             | `handlers.ts:850` vs `openapi.yaml` `UserStats.name` |
| P2-2 | `getStats` 返回 `memoCreatedTimestamps`，proto 字段名是 `memoDisplayTimestamps`；客户端不读，未知键被忽略，无功能影响                                                                               | `handlers.ts:859` vs `openapi.yaml:1396-1425`        |
| P2-3 | 默认头像是 `data:image/svg+xml,…`（blobatar）。客户端 `toUserSnapshot` 见 `url.host() == nil` 会拼成 `{host}/data:image/...` → 下载失败 → 头像恒为默认                                              | `src/lib/avatar.ts` + `MemosV1Service.swift:275-281` |
| P2-4 | `MemosV1Service.listResources()` 会打 `GET /api/v1/attachments` → 501。同步主路径 `SyncingRemoteService.listResources()` 只读本地库，所以暂不影响；一旦上游改用它就会炸                             | `SyncingRemoteService.swift:246-248`                 |
| P2-5 | V0 全套面（`/api/v1/memo*`、`/resource*`、`/tag`、`/user/me`、`/o/r/{uid}`）都是 501。因为客户端已经判成 V1，**这些是死路径**；但反过来说，`/api/v1/status` 一旦返回 200 就会被切到 V0 然后全盘失败 | 本文第一节 + `MemosV0Service/openapi.yaml`           |
| P2-6 | Mome 每位用户只允许一条置顶（唯一索引），MoeMemos 支持多条置顶                                                                                                                                      | `docs/memos-compatibility.md`「映射边界」            |
| P2-7 | `instance/profile` 多返回一个 `needsSetup`，proto 无此字段；JSON 解码忽略未知键，无害                                                                                                               | `handlers.ts:946`                                    |
| P2-8 | 客户端只在 host 相同时才附 `Authorization`，所以附件必须走**公开可读**的 URL；私有桶场景下 P1-1 的修复无效，需要额外设计                                                                            | `ServiceUtils/Auth.swift:38`                         |

## 五、不需要担心的部分（已核对）

- **widget（Memory / MemosGraph / QuickMemo）与 App Intent**：只读本地 SwiftData
  （`MemosGraphWidget.swift:36-46` 用 `accountManager.currentService` 的本地缓存），
  不发任何新请求。
- **CORS / OPTIONS**：原生 App 不需要，兼容层已实现，无影响。
- **分页**：客户端 `listMemos` 固定 `pageSize=200` 并循环到 `nextPageToken` 为空；
  兼容层返回 `''` 表示结束，语义匹配（`handlers.ts:412-423`、`json.ts:44-86`）。
- **`filter` 真实性**：实测 `creator == "users/does-not-exist"` 命中 0 条、
  `visibility in ["PUBLIC","PROTECTED"]` 正确排除私有 memo —— 过滤是真的在执行。
- **`users/{user}:getStats` 的 `:getStats` 后缀解析**：`matchPattern`
  （`handlers.ts:1058-1082`）按 `:user:getStats` 拆出裸 id，与客户端传裸 id 一致。
- **`updateMask` 缺省**：MoeMemos `UpdateMemo` 不带 `updateMask`，兼容层
  `parseFieldMask(null)` 返回 `null` → `wanted()` 对全部字段为真，
  与上游"空 mask = 全字段"的行为一致（`handlers.ts:493-496`）。
- **客户端下发的 `updateTime` 被忽略**：MoeMemos 每次 `UpdateMemo` 都带
  `updateTime`（`MemosV1Service.swift:154`），兼容层不把它接到
  `patchMemoForUser` 的 `expectedUpdatedAt`（`memos-core.ts:646-648`）。
  这不是兼容缺口——上游 Memos 0.30 的 `UpdateMemo` 同样是后写覆盖，
  没有基于 `updateTime` 的乐观并发；这里只是没用上 Mome 自己的并发能力。

## 六、建议修复顺序

| 顺序  | 动作                                                                       | 影响                        | 成本 |
| ----- | -------------------------------------------------------------------------- | --------------------------- | ---- |
| ~~0~~ | ~~时间戳去掉小数秒（P0-2）~~ **已完成**                                    | 解除登录阻断（真正的那条）  | 极低 |
| ~~1~~ | ~~实现 `GET …/settings/{setting}`（P0-1）~~ **已完成**                     | 解除登录阻断，MoeMemos 可用 | 低   |
| ~~2~~ | ~~`CreateAttachment` 补 `externalLink` / `createTime`（P1-1）~~ **已完成** | 附件能真正显示              | 极低 |
| ~~3~~ | ~~实现 `DELETE /api/v1/attachments/{attachment}`（P1-2）~~ **已完成**      | 停止永久重试 + 回收对象     | 低   |
| 4     | `memoJson` 输出 `attachments`（P1-3）                                      | 资源不再被摘链              | 中   |
| 5     | `PATCH memos/{memo}` 支持 `attachments` 追加（P1-4）                       | 消除静默数据丢失            | 中   |
| 6     | 修 P2-1 / P2-2 字段名                                                      | 规范对齐，无功能变化        | 极低 |

前 3 项已做完，MoeMemos 的登录 + 日常记录 + 图片（新建路径）可以真正跑通；
4 / 5 项决定"图片作为资源"这条线是否完整。

P1-5 / P1-6 不是"修 bug"，而是产品决策：是否放开非图片附件与容量口径、是否引入
一档 `PROTECTED`（登录用户可读）。这两项需要单独定，本文档只登记现状。

## 七、验证方法

探针脚本按 `src/server/memos-compat/memos-compat.test.ts` 的 harness 写法
（`useTestDatabase()` + 直调 `handleMemosCompat(new Request(...))`）逐条打真实 handler，
覆盖：版本探测两条、`auth/me`、`settings/GENERAL`、memo 增删改查（含 `state` 归档）、
两种客户端 filter、`getStats`、用户详情、附件上传 / 列表 / 删除、`/file/...` 回退路径。
脚本用完即删（`tsconfig.json` 的 `include: ["**/*.ts"]` 会把它纳入类型检查，
不适合留在仓库里）；需要复现时按上表路径重放即可。

本仓库自证（修复前）：`bun run test` = 70 passed / 0 failed。当时**没有一条用例覆盖
MoeMemos 的真实请求面**（没有 `settings/{setting}`、没有附件删除），所以"测试全绿"
推不出"MoeMemos 可用"——这正是 P0 能长期潜伏的原因。修复后补齐了这批契约测试，见下节。

本文的结论做过一次独立的二次复核（另一条独立通路重新走了一遍 V1 端点面、V0 可达性、
周边 target 与可见性映射），两遍结论一致：P0 唯一，就是 `settings/GENERAL`。

## 八、修复记录

| 编号     | 改动                                                                                                                                                                                         | 位置                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **P0-2** | 新增 `protoTimestamp()`，兼容层全部 13 处 `toISOString()` 改为输出 protojson 形态（**秒精度、无小数秒**）                                                                                    | `json.ts` + `dto.ts` / `handlers.ts` / `attachments.ts` / `auth.ts` |
| P0-1     | 新增 `GET /api/v1/users/{user}/settings` 与 `GET …/settings/{setting}`，`GENERAL` 的 `memoVisibility` 取站点级 `default_visibility`；其他 setting id 返回 `NOT_FOUND(5)`；ACL 为本人或管理员 | `src/server/memos-compat/handlers.ts`                               |
| P1-1     | `CreateAttachment` 响应补 `externalLink`（对象公开地址）与 `createTime`                                                                                                                      | `src/server/memos-compat/attachments.ts`                            |
| P1-2     | 新增 `DELETE /api/v1/attachments/{attachment}`：资源名尾段解回对象 key、校验归属后删 S3 对象，幂等                                                                                           | `src/server/memos-compat/attachments.ts` + `handlers.ts`            |

配套：把附件 id → 对象 key 的解析抽成 `attachmentObjectKeyFromToken`，让
`CreateMemo`（完整资源名）与 `DeleteAttachment`（裸 id）走同一套形状与归属校验，
避免两条路径各自漂移。

**修复后的实测闭环**（临时探针直打真实 handler，S3 用本地 stub 顶替）：

```
HTTP 200  GET    /api/v1/users/{id}/settings/GENERAL
          {"name":"users/…/settings/GENERAL","generalSetting":{"memoVisibility":"PRIVATE"}}
HTTP 200  POST   /api/v1/attachments
          {"name":"attachments/…","createTime":"…","filename":"photo.png",
           "type":"image/png","size":"8","externalLink":"https://cdn…/mome/memo-image/…png"}
          正文图片与 externalLink 一致: true
HTTP 200  DELETE /api/v1/attachments/{id}   {}
          S3 收到 PUT    /verify-bucket/mome/memo-image/verify-owner/01M2FZ…png
          S3 收到 DELETE /verify-bucket/mome/memo-image/verify-owner/01M2FZ…png   ← 同一个 key
```

P0-2 的验证是把**真实 dev server 的响应**（`curl /api/v1/instance/profile` 与
`/api/v1/memos`）里所有 RFC3339 字符串抽出来，逐个喂给复刻 runtime 配置的
`ISO8601DateFormatter`：

```
2026-08-08T12:39:43Z  OK     ← 修复前这里是 2026-08-08T12:39:43.541Z -> nil
2026-08-14T12:40:07Z  OK
…（14/14 全部 OK）
RESULT: all timestamps decode -> client will succeed
```

负向用例同样实测：无凭据删除 → `401(16)`；删别人的附件 → `403(7)`；
畸形 id → `400(3)`；未配 S3 删除 → `400(9)`；未知 setting → `404(5)`；
非管理员读他人设置 → `403(7)`，管理员可读他人设置但未知 setting 仍 `404(5)`。

**仍未修复**（本文档其他章节仍按其"修复前"描述理解）：P1-3、P1-4、P1-5、P1-6 与全部 P2。
其中 **P1-4（给已有 memo 加图静默丢失）是剩下的最高优先级**，它是数据丢失而非显示问题。

契约测试现状：`src/server/memos-compat/memos-compat.test.ts` 43 个用例
（全仓 80 个），新增覆盖 `settings`（含站点级默认可见性的两个分支）、
`CreateAttachment` 的 `externalLink`/`createTime` 与正文一致性、附件删除的正负路径、
以及 `protojson timestamps`（递归扫描 8 个端点的真实响应，断言时间戳一律
`YYYY-MM-DDTHH:MM:SSZ`、不含小数秒）。
`bun run test` / `bun run typecheck` / `bun run lint` / `bun run check` 全绿。

**教训**：第一版审计漏掉 P0-2，是因为验证停在"字段存在且类型是 string"，
没有把响应真的喂给客户端所用的解码器；契约测试也一样，它断言的是我们自己写的期望值。
对协议兼容这类问题，**按调用方的运行时（这里是 swift-openapi-runtime 的默认
`Configuration`）复刻一次解码**才算有效证据。
