/**
 * usememos/memos v1 REST 兼容层。
 *
 * 路径与字段按 usememos/memos v0.30.0 的 proto/openapi 对齐：
 * `/api/v1/memos`、`/api/v1/memos/{memo}`、`/api/v1/auth/*`、`/api/v1/users/*`、
 * `/api/v1/instance/profile` 等，错误体为 google.rpc.Status。
 *
 * 未实现的资源（附件、分享、webhook、通知、IDP、AI、instance settings）返回
 * UNIMPLEMENTED(12)，不做伪成功。
 */
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'

import { db } from '#/db'
import {
  adminUsers,
  apiKeys,
  memoLikes,
  memoLinks,
  memos,
  user,
} from '#/db/schema'
import type { memoComments } from '#/db/schema'
import { auth } from '#/lib/auth'
import { MAX_CONTENT } from '#/lib/limits'
import { createApiKeyForUser, revokeApiKeyForUser } from '../api-keys-core'
import { isPasswordLoginBlocked } from '../auth-policy'
import {
  addCommentForUser,
  listCommentsForMemo,
  toggleLikeForUser,
} from '../interactions-core'
import {
  createMemoForUser,
  deleteMemoForUser,
  patchMemoForUser,
  setPinForUser,
} from '../memos-core'
import { clientIp, rateLimitOrThrow } from '../rate-limit'
import { isAdminUser } from '../settings-core'
import {
  authenticate,
  clearRefreshCookie,
  issueAccessToken,
  issueRefreshToken,
  readRefreshCookie,
  refreshCookie,
  requireActor,
  consumeRefreshToken,
  refreshTokenSubject,
  revokeRefreshTokensForUser,
} from './auth'
import type { CompatActor } from './auth'
import {
  Code,
  MemosError,
  corsResponse,
  memosErrorResponse,
  memosJson,
  notImplemented,
} from './errors'
import {
  clampPageSize,
  decodePageToken,
  encodePageToken,
  parseFieldMask,
  parseTimestamp,
  resourceId,
} from './json'
import {
  MEMO_PREFIX,
  USER_PREFIX,
  commentJson,
  memoJson,
  memoName,
  personalAccessTokenJson,
  reactionJson,
  userJson,
  visibilityFromJson,
} from './dto'
import {
  listMemosForCompat,
  loadRelations,
  listUserRows,
  loadMemoForCompat,
  loadMemoRowForCompat,
  loadUserRow,
  requireOwnMemo,
  userStatsForCompat,
} from './service'

interface Ctx {
  request: Request
  url: URL
  params: Record<string, string>
}

type Handler = (ctx: Ctx) => Promise<Response>

/** 兼容层解析前的正文上限，与原生 /v1 的 MAX_BODY_BYTES 保持同一口径 */
const MAX_COMPAT_BODY_BYTES = 1024 * 1024

async function readBodyText(request: Request): Promise<string> {
  const declared = request.headers.get('content-length')
  if (declared) {
    const size = Number(declared)
    if (!Number.isFinite(size) || size > MAX_COMPAT_BODY_BYTES) {
      throw new MemosError(Code.INVALID_ARGUMENT, '请求体过大')
    }
  }
  if (!request.body) return ''
  // chunked / 无 Content-Length 时也要在解析前按字节截断
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_COMPAT_BODY_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new MemosError(Code.INVALID_ARGUMENT, '请求体过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const text = await readBodyText(request)
  if (!text.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof MemosError) throw error
    throw new MemosError(Code.INVALID_ARGUMENT, '请求体不是合法的 JSON 对象')
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new MemosError(Code.INVALID_ARGUMENT, `${field} 必须是字符串`)
  }
  return value
}

function requireVisibility(value: unknown): 'public' | 'private' | undefined {
  const visibility = visibilityFromJson(value)
  if (
    value !== undefined &&
    value !== null &&
    value !== '' &&
    visibility === undefined
  ) {
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      'visibility 只支持 PRIVATE / PROTECTED / PUBLIC',
    )
  }
  return visibility
}

function checkContentLength(content: string): void {
  if (content.length > MAX_CONTENT) {
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      `content 不能超过 ${MAX_CONTENT} 个字符`,
    )
  }
}

/**
 * cookie 凭据（浏览器会话 / refresh cookie）驱动的写操作必须来自可信 Origin：
 * SameSite=Lax 不阻止同站不同源页面发出的简单请求。
 * Bearer 客户端不带 cookie，也常常不带 Origin，这里不受影响。
 */
function assertTrustedOriginForCookieWrite(request: Request): void {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD') return
  if (!request.headers.get('cookie')) return
  const origin = request.headers.get('origin')
  const referer = request.headers.get('referer')
  const source = origin ?? (referer ? safeOrigin(referer) : null)
  // 没有 Origin/Referer 的写请求不可能来自浏览器页面（fetch/XHR 一定带 Origin），
  // 但它带了 cookie：保守放行会重新打开缺口，因此一并拒绝。
  if (!source || !isTrustedOrigin(source)) {
    throw new MemosError(
      Code.PERMISSION_DENIED,
      'cookie 鉴权的写操作必须来自可信 Origin；跨源客户端请改用 Bearer token',
    )
  }
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function isTrustedOrigin(origin: string): boolean {
  const configured = process.env.BETTER_AUTH_URL
  const allowed = new Set<string>()
  if (configured) allowed.add(safeOrigin(configured) ?? configured)
  if (process.env.NODE_ENV !== 'production') {
    allowed.add('http://localhost:3000')
    allowed.add('http://localhost:3001')
    allowed.add('http://127.0.0.1:3000')
    allowed.add('http://127.0.0.1:3001')
  }
  return allowed.has(origin)
}

async function limit(key: string, window: number, max: number): Promise<void> {
  try {
    await rateLimitOrThrow(`memos-compat:${key}`, { window, max })
  } catch {
    throw new MemosError(Code.RESOURCE_EXHAUSTED, '请求过于频繁，请稍后再试')
  }
}

async function limitRead(actor: CompatActor | null): Promise<void> {
  if (actor) {
    await limit(`read:${actor.id}`, 60, 240)
    return
  }
  await limit(`read:anon:${clientIp()}`, 60, 120)
}

async function limitWrite(actor: CompatActor): Promise<void> {
  await limit(`write:${actor.id}`, 60, 60)
}

// ── auth ────────────────────────────────────────────────
const authMe: Handler = async ({ request }) => {
  const actor = await requireActor(request)
  const row = await loadUserRow(actor.id)
  return memosJson({
    user: userJson(row, { isAdmin: actor.isAdmin, includeEmail: true }),
  })
}

/** Better Auth 的失败原因映射到 Memos 标准错误，避免一律吞成"密码错误" */
function signInError(error: unknown): MemosError {
  const statusCode =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined
  if (statusCode === 403) {
    return new MemosError(
      Code.PERMISSION_DENIED,
      '请求来源不被信任：请把客户端来源加入 BETTER_AUTH_URL / trustedOrigins',
    )
  }
  if (statusCode === 429) {
    return new MemosError(
      Code.RESOURCE_EXHAUSTED,
      '登录尝试过于频繁，请稍后再试',
    )
  }
  return new MemosError(Code.UNAUTHENTICATED, '用户名或密码错误')
}

const authSignin: Handler = async ({ request }) => {
  const body = await readJsonObject(request)
  const credentials = (body.passwordCredentials ?? body) as Record<
    string,
    unknown
  >
  const username = requireString(credentials.username, 'username').trim()
  const password = requireString(credentials.password, 'password')
  if (!username || !password) {
    throw new MemosError(Code.INVALID_ARGUMENT, 'username 与 password 不能为空')
  }
  await limit(`signin:${clientIp()}:${username}`, 60, 10)

  // 与站点登录入口共用邮箱验证策略：兼容层不能自带一套更宽松的判断
  if (
    await isPasswordLoginBlocked(
      username.includes('@') ? { email: username } : { username },
    )
  ) {
    throw new MemosError(Code.UNAUTHENTICATED, '用户名或密码错误')
  }

  let userId: string | null = null
  try {
    const result = await auth.api.signInUsername({
      body: { username, password },
      headers: request.headers,
    })
    userId = result.user.id
  } catch (error) {
    // 用户名登录失败且输入形如邮箱时，回退邮箱登录（Mome 用户可用邮箱登录）
    if (!username.includes('@')) throw signInError(error)
    try {
      const result = await auth.api.signInEmail({
        body: { email: username.toLowerCase(), password },
        headers: request.headers,
      })
      userId = result.user.id
    } catch (emailError) {
      throw signInError(emailError)
    }
  }
  if (!userId) {
    throw new MemosError(Code.UNAUTHENTICATED, '用户名或密码错误')
  }

  const row = await loadUserRow(userId)
  const access = issueAccessToken(row.id, row.username)
  const refresh = await issueRefreshToken(row.id)
  return memosJson(
    {
      user: userJson(row, {
        isAdmin: await isAdminUser(row.id),
        includeEmail: true,
      }),
      accessToken: access.accessToken,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
    },
    {
      headers: {
        'Set-Cookie': refreshCookie(refresh.refreshToken, refresh.expiresAt),
      },
    },
  )
}

const authRefresh: Handler = async ({ request }) => {
  const token = readRefreshCookie(request)
  const userId = token ? await consumeRefreshToken(token) : null
  if (!userId) {
    throw new MemosError(
      Code.UNAUTHENTICATED,
      'refresh token 缺失或已过期，请重新登录',
    )
  }
  const row = await loadUserRow(userId)
  const access = issueAccessToken(row.id, row.username)
  const refresh = await issueRefreshToken(row.id)
  return memosJson(
    {
      accessToken: access.accessToken,
      expiresAt: access.expiresAt.toISOString(),
    },
    {
      headers: {
        'Set-Cookie': refreshCookie(refresh.refreshToken, refresh.expiresAt),
      },
    },
  )
}

const authSignout: Handler = async ({ request }) => {
  // 退出必须让服务端 refresh 记录失效，仅清 cookie 挡不住已被复制的凭据
  const token = readRefreshCookie(request)
  const userId = token ? refreshTokenSubject(token) : null
  if (userId) await revokeRefreshTokensForUser(userId)
  return memosJson({}, { headers: { 'Set-Cookie': clearRefreshCookie() } })
}

// ── memos ───────────────────────────────────────────────
const MEMO_ID_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,34}[a-zA-Z0-9])?$/

const memosList: Handler = async ({ request, url }) => {
  const actor = await authenticate(request)
  await limitRead(actor)
  const stateParam = url.searchParams.get('state')
  const state =
    stateParam === 'ARCHIVED'
      ? 'ARCHIVED'
      : stateParam === 'NORMAL'
        ? 'NORMAL'
        : undefined
  const { items, nextPageToken } = await listMemosForCompat(actor, {
    pageSize: clampPageSize(url.searchParams.get('pageSize'), 50, 1000),
    cursor: decodePageToken(url.searchParams.get('pageToken')),
    state,
    filter: url.searchParams.get('filter') ?? undefined,
    orderBy: url.searchParams.get('orderBy') ?? undefined,
    showDeleted: url.searchParams.get('showDeleted') === 'true',
  })
  return memosJson({
    memos: items.map((item) => memoJson(item)),
    nextPageToken,
  })
}

const memosCreate: Handler = async ({ request, url }) => {
  const actor = await requireActor(request)
  await limitWrite(actor)
  const body = await readJsonObject(request)
  const memo = (body.memo ?? body) as Record<string, unknown>
  const content = requireString(memo.content, 'content')
  if (!content.trim()) {
    throw new MemosError(Code.INVALID_ARGUMENT, 'content 不能为空')
  }
  checkContentLength(content)
  const memoId = url.searchParams.get('memoId')?.trim()
  if (memoId && !MEMO_ID_PATTERN.test(memoId)) {
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      'memoId 需匹配 ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,34}[a-zA-Z0-9])?$',
    )
  }
  if (memoId) {
    const existing = await db.query.memos.findFirst({
      where: eq(memos.id, memoId),
      columns: { id: true },
    })
    if (existing) {
      throw new MemosError(Code.ALREADY_EXISTS, `memoId ${memoId} 已存在`)
    }
  }
  const created = await createMemoForUser(actor.id, content, {
    visibility: requireVisibility(memo.visibility),
    id: memoId || undefined,
    createdAt: parseTimestamp(memo.createTime, 'createTime'),
  })
  if (memo.pinned === true) {
    await setPinForUser(actor.id, created.id, true)
  }
  return memosJson(memoJson(await loadMemoForCompat(actor, created.id)))
}

const memoGet: Handler = async ({ request, params }) => {
  const actor = await authenticate(request)
  await limitRead(actor)
  const memoId = params.memo
  return memosJson(memoJson(await loadMemoForCompat(actor, memoId)))
}

const memoPatch: Handler = async ({ request, url, params }) => {
  const actor = await requireActor(request)
  await limitWrite(actor)
  const memoId = params.memo
  await requireOwnMemo(actor, memoId)

  const body = await readJsonObject(request)
  const memo = (body.memo ?? body) as Record<string, unknown>
  // 与 grpc-gateway 一致：body 里的 name 若出现，必须与路径一致
  if (memo.name !== undefined) {
    if (resourceId(memo.name, MEMO_PREFIX) !== memoId) {
      throw new MemosError(
        Code.INVALID_ARGUMENT,
        'body.memo.name 必须与请求路径中的 memo 一致',
      )
    }
  }
  const mask = parseFieldMask(url.searchParams.get('updateMask'))
  const wanted = (field: string): boolean =>
    mask === null || mask.has(field) || mask.has(camelToSnake(field))

  const patch: {
    content?: string
    visibility?: 'public' | 'private'
    pinned?: boolean
    archived?: boolean
  } = {}
  if (wanted('content') && memo.content !== undefined) {
    const content = requireString(memo.content, 'content')
    if (!content.trim()) {
      throw new MemosError(Code.INVALID_ARGUMENT, 'content 不能为空')
    }
    checkContentLength(content)
    patch.content = content
  }
  if (wanted('visibility') && memo.visibility !== undefined) {
    const visibility = requireVisibility(memo.visibility)
    if (visibility) patch.visibility = visibility
  }
  if (wanted('pinned') && memo.pinned !== undefined) {
    patch.pinned = Boolean(memo.pinned)
  }
  if (wanted('state') && memo.state !== undefined) {
    if (memo.state !== 'NORMAL' && memo.state !== 'ARCHIVED') {
      throw new MemosError(Code.INVALID_ARGUMENT, 'state 取值不合法')
    }
    patch.archived = memo.state === 'ARCHIVED'
  }
  if (Object.keys(patch).length > 0) {
    await patchMemoForUser(actor.id, memoId, patch)
  }
  return memosJson(memoJson(await loadMemoForCompat(actor, memoId)))
}

const memoDelete: Handler = async ({ request, params }) => {
  const actor = await requireActor(request)
  await limitWrite(actor)
  const memoId = params.memo
  await requireOwnMemo(actor, memoId)
  const result = await deleteMemoForUser(actor.id, memoId)
  if (!result.deleted) {
    throw new MemosError(Code.NOT_FOUND, `memo ${memoId} 不存在`)
  }
  return memosJson({})
}

// ── comments ────────────────────────────────────────────
function asCommentRow(input: {
  id: string
  memoId: string
  userId: string
  content: string
  createdAt: Date
}): typeof memoComments.$inferSelect {
  return { ...input, updatedAt: input.createdAt }
}

const commentsList: Handler = async ({ request, url, params }) => {
  const actor = await authenticate(request)
  await limitRead(actor)
  const memoId = params.memo
  const parent = await loadMemoRowForCompat(actor, memoId)
  const pageSize = clampPageSize(url.searchParams.get('pageSize'), 50, 1000)
  const { items, nextCursor } = await listCommentsForMemo(memoId, {
    limit: Math.min(pageSize, 50),
    cursor: url.searchParams.get('pageToken') ?? undefined,
  })
  return memosJson({
    memos: items.map((item) =>
      commentJson(
        asCommentRow({
          id: item.id,
          memoId,
          userId: item.author.id,
          content: item.content,
          createdAt: new Date(item.createdAt),
        }),
        { parentId: memoId, parentVisibility: parent.visibility },
      ),
    ),
    nextPageToken: nextCursor ?? '',
  })
}

const commentsCreate: Handler = async ({ request, params }) => {
  const actor = await requireActor(request)
  await limitWrite(actor)
  const memoId = params.memo
  const parent = await loadMemoRowForCompat(actor, memoId)
  const body = await readJsonObject(request)
  const comment = (body.comment ?? body) as Record<string, unknown>
  const content = requireString(comment.content, 'content').trim()
  if (!content) {
    throw new MemosError(Code.INVALID_ARGUMENT, 'comment.content 不能为空')
  }
  checkContentLength(content)
  const { comment: created } = await addCommentForUser(
    actor.id,
    memoId,
    content,
  )
  return memosJson(
    commentJson(
      asCommentRow({
        id: created.id,
        memoId,
        userId: created.author.id,
        content: created.content,
        createdAt: new Date(created.createdAt),
      }),
      { parentId: memoId, parentVisibility: parent.visibility },
    ),
  )
}

// ── reactions（Mome 的点赞 = 👍 反应）──────────────────
const SUPPORTED_REACTION = '👍'

async function listReactionsFor(
  memoId: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await db
    .select({ userId: memoLikes.userId, createdAt: memoLikes.createdAt })
    .from(memoLikes)
    .where(eq(memoLikes.memoId, memoId))
    .orderBy(asc(memoLikes.createdAt))
  return rows.map((row) => reactionJson(memoId, row.userId, row.createdAt))
}

const reactionsList: Handler = async ({ request, params }) => {
  const actor = await authenticate(request)
  await limitRead(actor)
  const memoId = params.memo
  await loadMemoRowForCompat(actor, memoId)
  return memosJson({
    reactions: await listReactionsFor(memoId),
    nextPageToken: '',
  })
}

const reactionsUpsert: Handler = async ({ request, params }) => {
  const actor = await requireActor(request)
  await limitWrite(actor)
  const memoId = params.memo
  await loadMemoRowForCompat(actor, memoId)
  const body = await readJsonObject(request)
  const reaction = (body.reaction ?? body) as Record<string, unknown>
  const type = reaction.reactionType ?? reaction.reaction_type
  if (type !== SUPPORTED_REACTION) {
    throw new MemosError(
      Code.UNIMPLEMENTED,
      `Mome 只支持 ${SUPPORTED_REACTION} 反应（对应点赞）`,
    )
  }
  const existing = await db.query.memoLikes.findFirst({
    where: and(eq(memoLikes.memoId, memoId), eq(memoLikes.userId, actor.id)),
  })
  if (!existing) await toggleLikeForUser(actor.id, memoId)
  return memosJson(reactionJson(memoId, actor.id, new Date()))
}

const reactionsDelete: Handler = async ({ request, params }) => {
  const actor = await requireActor(request)
  await limitWrite(actor)
  const memoId = params.memo
  await loadMemoRowForCompat(actor, memoId)
  if (params.reaction !== actor.id) {
    throw new MemosError(Code.PERMISSION_DENIED, '只能删除自己的反应')
  }
  const existing = await db.query.memoLikes.findFirst({
    where: and(eq(memoLikes.memoId, memoId), eq(memoLikes.userId, actor.id)),
  })
  if (existing) await toggleLikeForUser(actor.id, memoId)
  return memosJson({})
}

// ── relations（Mome 的 memo_links = REFERENCE）─────────
const relationsList: Handler = async ({ request, params }) => {
  const actor = await authenticate(request)
  await limitRead(actor)
  const memoId = params.memo
  await loadMemoRowForCompat(actor, memoId)
  const targets = await loadRelations(actor, [memoId])
  return memosJson({
    relations: (targets.get(memoId) ?? []).map((row) => ({
      memo: { name: memoName(memoId) },
      relatedMemo: {
        name: memoName(row.relatedMemoId),
        snippet: row.snippet,
      },
      type: 'REFERENCE',
    })),
    nextPageToken: '',
  })
}

const relationsSet: Handler = async ({ request, params }) => {
  const actor = await requireActor(request)
  await limitWrite(actor)
  const memoId = params.memo
  await requireOwnMemo(actor, memoId)
  const body = await readJsonObject(request)
  if (!Array.isArray(body.relations)) {
    throw new MemosError(Code.INVALID_ARGUMENT, 'relations 必须是数组')
  }
  const targetIds = body.relations.map((item) => {
    const relation = item as Record<string, unknown>
    const related = (relation.relatedMemo ?? relation.related_memo) as
      Record<string, unknown> | undefined
    return resourceId(related?.name, MEMO_PREFIX)
  })
  const unique = [...new Set(targetIds)].filter((id) => id !== memoId)
  if (unique.length > 0) {
    const found = await db
      .select({ id: memos.id })
      .from(memos)
      .where(
        and(
          inArray(memos.id, unique),
          eq(memos.userId, actor.id),
          isNull(memos.deletedAt),
        ),
      )
    if (found.length !== unique.length) {
      throw new MemosError(
        Code.FAILED_PRECONDITION,
        'relations 只能引用自己未删除的 memo',
      )
    }
  }
  await db.transaction(async (tx) => {
    await tx.delete(memoLinks).where(eq(memoLinks.sourceId, memoId))
    if (unique.length > 0) {
      const now = new Date()
      await tx
        .insert(memoLinks)
        .values(
          unique.map((targetId) => ({
            sourceId: memoId,
            targetId,
            createdAt: now,
          })),
        )
        .onConflictDoNothing()
    }
  })
  return memosJson({})
}

// ── users ───────────────────────────────────────────────
function usernameFilter(filter: string | null): string | undefined {
  if (!filter) return undefined
  const match = /^\s*username\s*==\s*["'](.+?)["']\s*$/.exec(filter)
  if (!match) {
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      'ListUsers 的 filter 只支持 username == "xxx"',
    )
  }
  return match[1]
}

/** 批量查询管理员身份，避免每行一次数据库往返 */
async function loadAdminIds(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const rows = await db
    .select({ userId: adminUsers.userId })
    .from(adminUsers)
    .where(inArray(adminUsers.userId, userIds))
  return new Set(rows.map((row) => row.userId))
}

const usersList: Handler = async ({ request, url }) => {
  const actor = await requireActor(request)
  await limitRead(actor)
  const pageSize = clampPageSize(url.searchParams.get('pageSize'), 50, 1000)
  const offset = decodePageToken(url.searchParams.get('pageToken')).offset
  const { rows, hasMore } = await listUserRows({
    limit: pageSize,
    offset,
    username: usernameFilter(url.searchParams.get('filter')),
  })
  // 角色一次批量查询：逐行 isAdminUser 在 pageSize 最大 1000 时是真正的 N+1
  const admins = await loadAdminIds(rows.map((row) => row.id))
  const users = rows.map((row) =>
    userJson(row, {
      isAdmin: admins.has(row.id),
      includeEmail: actor.isAdmin || row.id === actor.id,
    }),
  )
  return memosJson({
    users,
    nextPageToken: hasMore ? encodePageToken(offset + pageSize) : '',
  })
}

const usersBatchGet: Handler = async ({ request }) => {
  const actor = await requireActor(request)
  await limitRead(actor)
  const body = await readJsonObject(request)
  const names = Array.isArray(body.names) ? body.names : []
  const ids = names.map((name) => resourceId(name, USER_PREFIX))
  const rows =
    ids.length === 0
      ? []
      : await db.select().from(user).where(inArray(user.id, ids))
  const admins = await loadAdminIds(rows.map((row) => row.id))
  const users = rows.map((row) =>
    userJson(row, {
      isAdmin: admins.has(row.id),
      includeEmail: actor.isAdmin || row.id === actor.id,
    }),
  )
  return memosJson({ users })
}

const userGet: Handler = async ({ request, params }) => {
  const actor = await requireActor(request)
  await limitRead(actor)
  const row = await loadUserRow(params.user)
  return memosJson(
    userJson(row, {
      isAdmin: await isAdminUser(row.id),
      includeEmail: actor.isAdmin || row.id === actor.id,
    }),
  )
}

const userStats: Handler = async ({ request, params }) => {
  const actor = await requireActor(request)
  await limitRead(actor)
  const userId = params.user
  await loadUserRow(userId)
  const stats = await userStatsForCompat(userId)
  return memosJson({
    name: `${USER_PREFIX}/${userId}/stats`,
    memoTypeStats: {
      linkCount: 0,
      codeCount: 0,
      todoCount: 0,
      undoCount: 0,
    },
    tagCount: stats.tagCount,
    totalMemoCount: stats.total,
    memoCreatedTimestamps: stats.createdTimestamps.map((date) =>
      date.toISOString(),
    ),
    pinnedMemos: stats.pinnedMemos,
  })
}

// ── personal access tokens ──────────────────────────────
const patList: Handler = async ({ request, params }) => {
  const actor = await requireActor(request)
  await limitRead(actor)
  const userId = params.user
  if (userId !== actor.id && !actor.isAdmin) {
    throw new MemosError(Code.PERMISSION_DENIED, '只能查看自己的 PAT')
  }
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt))
  return memosJson({
    personalAccessTokens: rows.map((row) =>
      personalAccessTokenJson(userId, row),
    ),
    nextPageToken: '',
  })
}

const patCreate: Handler = async ({ request, params }) => {
  const actor = await requireActor(request)
  await limitWrite(actor)
  const userId = params.user
  if (userId !== actor.id) {
    throw new MemosError(Code.PERMISSION_DENIED, '只能为自己创建 PAT')
  }
  const body = await readJsonObject(request)
  const description =
    typeof body.description === 'string' ? body.description.trim() : ''
  const expiresInDays = Number(body.expiresInDays ?? body.expires_in_days ?? 0)
  if (!Number.isInteger(expiresInDays) || expiresInDays < 0) {
    throw new MemosError(Code.INVALID_ARGUMENT, 'expiresInDays 必须是非负整数')
  }
  const expiresAt =
    expiresInDays > 0 ? new Date(Date.now() + expiresInDays * 86_400_000) : null
  const { key, token } = await createApiKeyForUser(
    userId,
    description || 'Memos PAT',
    { expiresAt, kind: 'memosPat' },
  )
  const row = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.id, key.id),
  })
  return memosJson({
    personalAccessToken: row ? personalAccessTokenJson(userId, row) : null,
    token,
  })
}

const patDelete: Handler = async ({ request, params }) => {
  const actor = await requireActor(request)
  await limitWrite(actor)
  const userId = params.user
  if (userId !== actor.id && !actor.isAdmin) {
    throw new MemosError(Code.PERMISSION_DENIED, '只能撤销自己的 PAT')
  }
  try {
    await revokeApiKeyForUser(userId, params.personalAccessToken)
  } catch {
    throw new MemosError(Code.NOT_FOUND, 'PAT 不存在或已撤销')
  }
  return memosJson({})
}

// ── instance ────────────────────────────────────────────
const instanceProfile: Handler = async () => {
  const adminRow = (
    await db
      .select()
      .from(adminUsers)
      .orderBy(asc(adminUsers.createdAt))
      .limit(1)
  ).at(0)
  const anyUser = await db.select({ id: user.id }).from(user).limit(1)
  const json: Record<string, unknown> = {
    version: '0.30.0',
    demo: false,
    instanceUrl: process.env.BETTER_AUTH_URL ?? '',
    needsSetup: anyUser.length === 0,
  }
  if (adminRow) {
    const row = await loadUserRow(adminRow.userId)
    json.admin = userJson(row, { isAdmin: true, includeEmail: true })
  }
  return memosJson(json)
}

// ── 路由表 ──────────────────────────────────────────────
interface Route {
  method: string
  pattern: string[]
  handler: Handler
}

const ROUTES: Route[] = [
  { method: 'GET', pattern: ['auth', 'me'], handler: authMe },
  { method: 'POST', pattern: ['auth', 'signin'], handler: authSignin },
  { method: 'POST', pattern: ['auth', 'signout'], handler: authSignout },
  { method: 'POST', pattern: ['auth', 'refresh'], handler: authRefresh },
  { method: 'GET', pattern: ['memos'], handler: memosList },
  { method: 'POST', pattern: ['memos'], handler: memosCreate },
  { method: 'GET', pattern: ['memos', ':memo'], handler: memoGet },
  { method: 'PATCH', pattern: ['memos', ':memo'], handler: memoPatch },
  { method: 'DELETE', pattern: ['memos', ':memo'], handler: memoDelete },
  {
    method: 'GET',
    pattern: ['memos', ':memo', 'comments'],
    handler: commentsList,
  },
  {
    method: 'POST',
    pattern: ['memos', ':memo', 'comments'],
    handler: commentsCreate,
  },
  {
    method: 'GET',
    pattern: ['memos', ':memo', 'reactions'],
    handler: reactionsList,
  },
  {
    method: 'POST',
    pattern: ['memos', ':memo', 'reactions'],
    handler: reactionsUpsert,
  },
  {
    method: 'DELETE',
    pattern: ['memos', ':memo', 'reactions', ':reaction'],
    handler: reactionsDelete,
  },
  {
    method: 'GET',
    pattern: ['memos', ':memo', 'relations'],
    handler: relationsList,
  },
  {
    method: 'PATCH',
    pattern: ['memos', ':memo', 'relations'],
    handler: relationsSet,
  },
  { method: 'GET', pattern: ['users'], handler: usersList },
  { method: 'POST', pattern: ['users:batchGet'], handler: usersBatchGet },
  { method: 'GET', pattern: ['users', ':user:getStats'], handler: userStats },
  { method: 'GET', pattern: ['users', ':user'], handler: userGet },
  {
    method: 'GET',
    pattern: ['users', ':user', 'personalAccessTokens'],
    handler: patList,
  },
  {
    method: 'POST',
    pattern: ['users', ':user', 'personalAccessTokens'],
    handler: patCreate,
  },
  {
    method: 'DELETE',
    pattern: ['users', ':user', 'personalAccessTokens', ':personalAccessToken'],
    handler: patDelete,
  },
  { method: 'GET', pattern: ['instance', 'profile'], handler: instanceProfile },
]

const UNIMPLEMENTED: Array<{ method: string; pattern: string[] }> = [
  { method: 'GET', pattern: ['attachments'] },
  { method: 'POST', pattern: ['attachments'] },
  { method: 'POST', pattern: ['attachments:batchDelete'] },
  { method: 'GET', pattern: ['attachments', ':attachment'] },
  { method: 'PATCH', pattern: ['attachments', ':attachment'] },
  { method: 'DELETE', pattern: ['attachments', ':attachment'] },
  { method: 'GET', pattern: ['memos', ':memo', 'attachments'] },
  { method: 'PATCH', pattern: ['memos', ':memo', 'attachments'] },
  { method: 'GET', pattern: ['memos', ':memo', 'shares'] },
  { method: 'POST', pattern: ['memos', ':memo', 'shares'] },
  { method: 'DELETE', pattern: ['memos', ':memo', 'shares', ':share'] },
  { method: 'GET', pattern: ['shares', ':shareToken', 'memo'] },
  { method: 'GET', pattern: ['memos', '-', 'linkMetadata'] },
  { method: 'POST', pattern: ['memos', '-', 'linkMetadata:batchGet'] },
  { method: 'GET', pattern: ['users:stats'] },
  { method: 'GET', pattern: ['users', ':user', 'settings'] },
  { method: 'GET', pattern: ['users', ':user', 'webhooks'] },
  { method: 'GET', pattern: ['users', ':user', 'notifications'] },
  { method: 'GET', pattern: ['users', ':user', 'linkedIdentities'] },
  { method: 'GET', pattern: ['identity-providers'] },
  { method: 'GET', pattern: ['instance', 'stats'] },
  { method: 'GET', pattern: ['instance', ':instance'] },
]

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
}

function matchPattern(
  pattern: string[],
  segments: string[],
): Record<string, string> | null {
  if (pattern.length !== segments.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < pattern.length; i++) {
    const part = pattern[i]
    const segment = segments[i]
    if (part.startsWith(':')) {
      const [, name, suffix] = part.split(':')
      if (suffix) {
        if (!segment.endsWith(`:${suffix}`)) return null
        const value = segment.slice(0, -(suffix.length + 1))
        if (!value) return null
        params[name] = value
      } else {
        params[name] = segment
      }
      continue
    }
    if (part !== segment) return null
  }
  return params
}

function findRoute(
  method: string,
  segments: string[],
): { handler: Handler; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue
    const params = matchPattern(route.pattern, segments)
    if (params) return { handler: route.handler, params }
  }
  return null
}

function isKnownUnimplemented(method: string, segments: string[]): boolean {
  return UNIMPLEMENTED.some(
    (route) => route.method === method && matchPattern(route.pattern, segments),
  )
}

export async function handleMemosCompat(request: Request): Promise<Response> {
  try {
    if (request.method === 'OPTIONS') return corsResponse()
    assertTrustedOriginForCookieWrite(request)
    const url = new URL(request.url)
    const segments = url.pathname
      .replace(/^\/api\/v1\/?/, '')
      .split('/')
      .filter(Boolean)
    const matched = findRoute(request.method, segments)
    if (matched) {
      return await matched.handler({ request, url, params: matched.params })
    }
    const path = `/api/v1/${segments.join('/')}`
    if (isKnownUnimplemented(request.method, segments)) {
      throw notImplemented(`${request.method} ${path}`)
    }
    throw new MemosError(
      Code.UNIMPLEMENTED,
      `${request.method} ${path} 不在 Mome 的 Memos 兼容范围内`,
    )
  } catch (error) {
    return memosErrorResponse(error)
  }
}
