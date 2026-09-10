/**
 * Memos 兼容层的查询层：把 Mome 的表结构投影成兼容 API 需要的视图。
 *
 * ACL 口径（与上游 ListMemos/GetMemo 的可读语义对齐）：
 * - 匿名：仅 PUBLIC 且未归档、未删除的 memo；
 * - 已认证：自己的全部 memo（含归档/回收站）+ 他人的 PUBLIC 且未归档 memo。
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { db } from '#/db'
import { memoLikes, memoLinks, memos, memoTags, tags, user } from '#/db/schema'
import { Code, MemosError } from './errors'
import { compileMemosFilter } from './cel'
import { encodeKeysetPageToken, encodePageToken } from './json'
import type { PageCursor } from './json'
import type { CompatActor } from './auth'
import type { MemoJsonInput, MemosState, ReactionView } from './dto'

type MemoRow = typeof memos.$inferSelect

const PUBLIC_READABLE = and(
  eq(memos.visibility, 'public'),
  eq(memos.archived, false),
  isNull(memos.deletedAt),
)

function readAcl(actor: CompatActor | null, includeDeleted: boolean): SQL {
  const base = actor
    ? or(eq(memos.userId, actor.id), PUBLIC_READABLE)!
    : PUBLIC_READABLE!
  return includeDeleted ? base : and(base, isNull(memos.deletedAt))!
}

export interface ListMemosCompatParams {
  pageSize: number
  cursor: PageCursor
  state?: MemosState
  filter?: string
  orderBy?: string
  showDeleted: boolean
}

function orderExpressions(orderBy: string | undefined): SQL[] {
  if (!orderBy) return [desc(memos.createdAt), desc(memos.id)]
  const expressions: SQL[] = []
  for (const raw of orderBy.split(',')) {
    const parts = raw.trim().split(/\s+/)
    const field = parts[0]
    const direction = (parts[1] ?? 'desc').toLowerCase()
    if (direction !== 'asc' && direction !== 'desc') {
      throw new MemosError(
        Code.INVALID_ARGUMENT,
        `orderBy 的方向只支持 asc/desc: ${raw.trim()}`,
      )
    }
    const column =
      field === 'create_time'
        ? memos.createdAt
        : field === 'update_time'
          ? memos.updatedAt
          : field === 'pinned'
            ? memos.pinned
            : field === 'name'
              ? memos.id
              : null
    if (!column) {
      throw new MemosError(
        Code.INVALID_ARGUMENT,
        `orderBy 不支持字段 ${field}（支持 pinned / create_time / update_time / name）`,
      )
    }
    expressions.push(direction === 'asc' ? asc(column) : desc(column))
  }
  return [...expressions, desc(memos.id)]
}

/** 页面内 memo 的完整标签路径（Mome 只把 memo 关联到叶子标签） */
async function loadTagPaths(
  memoIds: string[],
  ownerIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (memoIds.length === 0) return result
  const tagRows = await db
    .select({
      memoId: memoTags.memoId,
      tagId: memoTags.tagId,
      name: tags.name,
      parentId: tags.parentId,
    })
    .from(memoTags)
    .innerJoin(tags, eq(tags.id, memoTags.tagId))
    .where(inArray(memoTags.memoId, memoIds))
  if (tagRows.length === 0) return result

  const allTags = await db
    .select({ id: tags.id, name: tags.name, parentId: tags.parentId })
    .from(tags)
    .where(inArray(tags.userId, ownerIds))
  const byId = new Map(allTags.map((row) => [row.id, row]))
  const pathCache = new Map<string, string>()
  const pathOf = (id: string): string => {
    const cached = pathCache.get(id)
    if (cached !== undefined) return cached
    const row = byId.get(id)
    if (!row) return ''
    const parentPath = row.parentId ? pathOf(row.parentId) : ''
    const path = parentPath ? `${parentPath}/${row.name}` : row.name
    pathCache.set(id, path)
    return path
  }
  for (const row of tagRows) {
    const path = pathOf(row.tagId)
    if (!path) continue
    const list = result.get(row.memoId) ?? []
    if (!list.includes(path)) list.push(path)
    result.set(row.memoId, list)
  }
  return result
}

async function loadReactions(
  memoIds: string[],
): Promise<Map<string, ReactionView[]>> {
  const result = new Map<string, ReactionView[]>()
  if (memoIds.length === 0) return result
  const rows = await db
    .select({
      memoId: memoLikes.memoId,
      userId: memoLikes.userId,
      createdAt: memoLikes.createdAt,
    })
    .from(memoLikes)
    .where(inArray(memoLikes.memoId, memoIds))
  for (const row of rows) {
    const list = result.get(row.memoId) ?? []
    list.push({ userId: row.userId, createdAt: row.createdAt })
    result.set(row.memoId, list)
  }
  return result
}

/**
 * 关联目标必须套用与单资源读取相同的 ACL：用户可以引用自己的私有 memo，
 * 若这里只过滤 deletedAt，公开源 memo 会把私有目标的 ID 与摘要一并泄露。
 * 不可读的目标整条省略，而不是只隐藏 snippet。
 */
export async function loadRelations(
  actor: CompatActor | null,
  memoIds: string[],
): Promise<Map<string, MemoJsonInput['relations']>> {
  const result = new Map<string, MemoJsonInput['relations']>()
  if (memoIds.length === 0) return result
  const rows = await db
    .select({
      sourceId: memoLinks.sourceId,
      targetId: memoLinks.targetId,
      content: memos.content,
    })
    .from(memoLinks)
    .innerJoin(memos, eq(memos.id, memoLinks.targetId))
    .where(and(inArray(memoLinks.sourceId, memoIds), readAcl(actor, false)))
  for (const row of rows) {
    const list = result.get(row.sourceId) ?? []
    list.push({
      memoId: row.sourceId,
      relatedMemoId: row.targetId,
      snippet: row.content.slice(0, 120),
    })
    result.set(row.sourceId, list)
  }
  return result
}

async function toMemoInputs(
  actor: CompatActor | null,
  rows: MemoRow[],
): Promise<MemoJsonInput[]> {
  const memoIds = rows.map((row) => row.id)
  const ownerIds = [...new Set(rows.map((row) => row.userId))]
  const [tagPaths, reactions, relations] = await Promise.all([
    loadTagPaths(memoIds, ownerIds),
    loadReactions(memoIds),
    loadRelations(actor, memoIds),
  ])
  return rows.map((row) => ({
    row,
    tags: tagPaths.get(row.id) ?? [],
    reactions: reactions.get(row.id) ?? [],
    relations: relations.get(row.id) ?? [],
  }))
}

export async function listMemosForCompat(
  actor: CompatActor | null,
  params: ListMemosCompatParams,
): Promise<{ items: MemoJsonInput[]; nextPageToken: string }> {
  const conditions: SQL[] = [readAcl(actor, params.showDeleted)]
  if (!params.showDeleted) conditions.push(isNull(memos.deletedAt))
  if (params.state === 'ARCHIVED') {
    conditions.push(eq(memos.archived, true))
  } else {
    conditions.push(eq(memos.archived, false))
  }
  if (params.filter) {
    const compiled = await compileMemosFilter(params.filter)
    if (compiled) conditions.push(compiled)
  }
  // 默认排序可用 keyset：深页不随 offset 变慢，也不会因新记录插入而漂移。
  // 其他 orderBy 仍走 offset（正确但深页较慢），旧的 offset token 继续兼容。
  const keysetable = isDefaultOrder(params.orderBy)
  const cursor = params.cursor
  if (keysetable && cursor.keyset) {
    conditions.push(
      sql`(${memos.createdAt}, ${memos.id}) < (${cursor.keyset.createdAt}, ${cursor.keyset.id})`,
    )
  }
  const offset = cursor.keyset ? 0 : cursor.offset
  const rows = await db
    .select()
    .from(memos)
    .where(and(...conditions))
    .orderBy(...orderExpressions(params.orderBy))
    .limit(params.pageSize + 1)
    .offset(offset)

  const hasMore = rows.length > params.pageSize
  const page = rows.slice(0, params.pageSize)
  const last = page.at(-1)
  return {
    items: await toMemoInputs(actor, page),
    nextPageToken: !hasMore
      ? ''
      : keysetable && last
        ? encodeKeysetPageToken(last.createdAt, last.id)
        : encodePageToken(offset + params.pageSize),
  }
}

/** 默认排序等价于 create_time desc, id desc，只有它能安全地转成 keyset */
function isDefaultOrder(orderBy: string | undefined): boolean {
  if (!orderBy) return true
  const parts = orderBy.split(',').map((part) => part.trim().toLowerCase())
  return (
    parts.length === 1 &&
    (parts[0] === 'create_time' || parts[0] === 'create_time desc')
  )
}

/** 读取单条可读 memo；不可读、已删除与不存在同样返回 NOT_FOUND，避免泄漏存在性 */
export async function loadMemoRowForCompat(
  actor: CompatActor | null,
  memoId: string,
): Promise<MemoRow> {
  const rows = await db
    .select()
    .from(memos)
    .where(and(eq(memos.id, memoId), readAcl(actor, false)))
    .limit(1)
  const row = rows.at(0)
  if (!row) {
    throw new MemosError(Code.NOT_FOUND, `memo ${memoId} 不存在或无权访问`)
  }
  return row
}

export async function loadMemoForCompat(
  actor: CompatActor | null,
  memoId: string,
): Promise<MemoJsonInput> {
  const row = await loadMemoRowForCompat(actor, memoId)
  const [input] = await toMemoInputs(actor, [row])
  return input
}

/** 写操作要求 memo 属于当前用户 */
export async function requireOwnMemo(
  actor: CompatActor,
  memoId: string,
): Promise<MemoRow> {
  const row = await loadMemoRowForCompat(actor, memoId)
  if (row.userId !== actor.id) {
    throw new MemosError(Code.PERMISSION_DENIED, '只能操作自己的 memo')
  }
  return row
}

export async function loadUserRow(
  userId: string,
): Promise<typeof user.$inferSelect> {
  const row = await db.query.user.findFirst({ where: eq(user.id, userId) })
  if (!row) {
    throw new MemosError(Code.NOT_FOUND, `user ${userId} 不存在`)
  }
  return row
}

export async function listUserRows(opts: {
  limit: number
  offset: number
  username?: string
}): Promise<{ rows: Array<typeof user.$inferSelect>; hasMore: boolean }> {
  const conditions = opts.username ? [eq(user.username, opts.username)] : []
  const rows = await db
    .select()
    .from(user)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(user.createdAt), asc(user.id))
    .limit(opts.limit + 1)
    .offset(opts.offset)
  return { rows: rows.slice(0, opts.limit), hasMore: rows.length > opts.limit }
}

/** 用户维度的统计：总数、标签计数、创建时间线、置顶 memo */
export async function userStatsForCompat(userId: string): Promise<{
  total: number
  tagCount: Record<string, number>
  createdTimestamps: Date[]
  pinnedMemos: string[]
}> {
  const rows = await db
    .select()
    .from(memos)
    .where(
      and(
        eq(memos.userId, userId),
        eq(memos.archived, false),
        isNull(memos.deletedAt),
      ),
    )
    .orderBy(asc(memos.createdAt))
  const memoIds = rows.map((row) => row.id)
  const tagCount: Record<string, number> = {}
  if (memoIds.length > 0) {
    const paths = await loadTagPaths(memoIds, [userId])
    for (const list of paths.values()) {
      for (const path of list) tagCount[path] = (tagCount[path] ?? 0) + 1
    }
  }
  return {
    total: rows.length,
    tagCount,
    createdTimestamps: rows.map((row) => row.createdAt),
    pinnedMemos: rows
      .filter((row) => row.pinned)
      .map((row) => `memos/${row.id}`),
  }
}
