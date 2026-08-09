import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lt,
  or,
  sql,
} from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { db } from '#/db'
import { memos, memoTags, tags } from '#/db/schema'
import { parseHashtags, tagPathToSegments } from '#/lib/hashtags'
import { escapeLike } from '#/lib/search'
import { ulid } from '#/lib/ulid'
import {
  EMPTY_COUNTS,
  EMPTY_VIEWER_STATE,
  loadMemoCounts,
  loadViewerStates,
} from './interactions-core'
import type { MemoCounts, ViewerState } from './interactions-core'

export const MAX_CONTENT = 5000

export interface MemoWithTags {
  id: string
  content: string
  visibility: 'public' | 'private'
  pinned: boolean
  globalPinned: boolean
  archived: boolean
  createdAt: string
  updatedAt: string
  tags: Array<{ id: string; name: string; parentId: string | null }>
  counts: MemoCounts
  viewerState: ViewerState
}

export interface ListMemosParams {
  cursor?: string
  limit?: number
  tag?: string
  q?: string
  filter?: 'all' | 'archived'
}

// db.transaction 回调里的事务类型
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function toMemoWithTags(
  memo: typeof memos.$inferSelect,
  tagRows: Array<{ tagId: string; tagName: string; parentId: string | null }>,
  counts: MemoCounts = EMPTY_COUNTS,
  viewerState: ViewerState = EMPTY_VIEWER_STATE,
): MemoWithTags {
  return {
    id: memo.id,
    content: memo.content,
    visibility: memo.visibility,
    pinned: memo.pinned,
    globalPinned: memo.globalPinned,
    archived: memo.archived,
    createdAt: memo.createdAt.toISOString(),
    updatedAt: memo.updatedAt.toISOString(),
    tags: tagRows.map((t) => ({
      id: t.tagId,
      name: t.tagName,
      parentId: t.parentId,
    })),
    counts,
    viewerState,
  }
}

// 在事务内同步标签：按 content 解析 → find-or-create → 写 memo_tags
async function syncTagsForContent(
  tx: Tx,
  userId: string,
  memoId: string,
  content: string,
): Promise<void> {
  const paths = parseHashtags(content)

  // 先清掉旧的关联
  await tx.delete(memoTags).where(eq(memoTags.memoId, memoId))

  for (const path of paths) {
    const segments = tagPathToSegments(path)
    let parentId: string | null = null
    for (const seg of segments) {
      const cond: SQL | undefined =
        parentId === null
          ? and(
              eq(tags.userId, userId),
              eq(tags.name, seg),
              isNull(tags.parentId),
            )
          : and(
              eq(tags.userId, userId),
              eq(tags.name, seg),
              eq(tags.parentId, parentId),
            )
      let tag: typeof tags.$inferSelect | undefined =
        await tx.query.tags.findFirst({
          where: cond,
        })
      if (!tag) {
        const id = crypto.randomUUID()
        await tx.insert(tags).values({
          id,
          userId,
          name: seg,
          parentId,
          createdAt: new Date(),
        })
        tag = {
          id,
          userId,
          name: seg,
          parentId,
          parentKey: parentId ?? '',
          createdAt: new Date(),
        }
      }
      parentId = tag.id
    }
    if (parentId) {
      await tx
        .insert(memoTags)
        .values({ memoId, tagId: parentId })
        .onConflictDoNothing()
    }
  }
}

/** 清理不再被任何 memo 引用、且没有子标签的标签（自底向上循环删除） */
async function cleanupOrphanTags(tx: Tx, userId: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const deleted = await tx.all(
      sql`
        DELETE FROM tags
        WHERE user_id = ${userId}
          AND id NOT IN (SELECT tag_id FROM memo_tags)
          AND id NOT IN (SELECT parent_id FROM tags WHERE parent_id IS NOT NULL)
        RETURNING id
      `,
    )
    if (deleted.length === 0) break
  }
}

export async function loadMemoTags(memoIds: string[]): Promise<
  Array<{
    memoId: string
    tagId: string
    tagName: string
    parentId: string | null
  }>
> {
  if (memoIds.length === 0) return []
  const rows = await db
    .select({
      memoId: memoTags.memoId,
      tagId: memoTags.tagId,
      tagName: tags.name,
      parentId: tags.parentId,
    })
    .from(memoTags)
    .innerJoin(tags, eq(memoTags.tagId, tags.id))
    .where(inArray(memoTags.memoId, memoIds))
  return rows
}

// ── create ───────────────────────────────────────────────
export async function createMemoForUser(
  userId: string,
  content: string,
  opts: { visibility?: 'public' | 'private' } = {},
): Promise<MemoWithTags> {
  const now = new Date()
  const memo = {
    id: ulid(),
    userId,
    content,
    visibility: opts.visibility ?? 'private',
    pinned: false,
    globalPinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
  }

  await db.transaction(async (tx) => {
    await tx.insert(memos).values(memo)
    await syncTagsForContent(tx, userId, memo.id, content)
    await cleanupOrphanTags(tx, userId)
  })

  return toMemoWithTags(
    memo,
    await loadMemoTags([memo.id]),
    EMPTY_COUNTS,
    EMPTY_VIEWER_STATE,
  )
}

// ── list（游标分页 + tag/q/filter） ──────────────────────
export async function listMemosForUser(
  userId: string,
  params: ListMemosParams = {},
  viewerId: string | null = userId,
): Promise<{ items: MemoWithTags[]; nextCursor: string | null }> {
  const limit = params.limit ?? 20
  const conditions = [eq(memos.userId, userId)]
  if (params.filter === 'archived') {
    conditions.push(eq(memos.archived, true))
  } else {
    conditions.push(eq(memos.archived, false))
  }
  if (params.q) {
    conditions.push(
      like(memos.content, sql`${`%${escapeLike(params.q)}%`} ESCAPE '\\'`),
    )
  }
  if (params.tag) {
    const tagIds = await resolveTagIds(userId, params.tag)
    if (tagIds.length === 0) return { items: [], nextCursor: null }
    const memoIds = db
      .select({ memoId: memoTags.memoId })
      .from(memoTags)
      .where(inArray(memoTags.tagId, tagIds))
    conditions.push(inArray(memos.id, memoIds))
  }

  // keyset 游标：{ p: pinned, c: createdAt ms, i: id }
  let cursorCond: ReturnType<typeof and> | undefined
  if (params.cursor) {
    const cur = parseCursor(params.cursor)
    if (cur) {
      const cDate = new Date(cur.c)
      const cursorConditions =
        cur.p === 1
          ? [
              // 置顶区内部
              and(eq(memos.pinned, true), lt(memos.createdAt, cDate)),
              and(
                eq(memos.pinned, true),
                eq(memos.createdAt, cDate),
                lt(memos.id, cur.i),
              ),
              // 已读完全部置顶，进入普通区
              and(eq(memos.pinned, false)),
            ]
          : [
              // 普通区内部
              and(eq(memos.pinned, false), lt(memos.createdAt, cDate)),
              and(
                eq(memos.pinned, false),
                eq(memos.createdAt, cDate),
                lt(memos.id, cur.i),
              ),
            ]
      cursorCond = or(...cursorConditions)
      if (cursorCond) conditions.push(cursorCond)
    }
  }

  const rows = await db
    .select()
    .from(memos)
    .where(and(...conditions))
    .orderBy(desc(memos.pinned), desc(memos.createdAt), desc(memos.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const memoIds = page.map((m) => m.id)
  const [tagRows, countsMap, viewerMap] = await Promise.all([
    loadMemoTags(memoIds),
    loadMemoCounts(memoIds),
    loadViewerStates(memoIds, viewerId),
  ])

  const items = page.map((m) =>
    toMemoWithTags(m, tagRows, countsMap.get(m.id), viewerMap.get(m.id)),
  )
  const last = page[page.length - 1]
  let nextCursor: string | null = null
  if (hasMore) {
    nextCursor = Buffer.from(
      JSON.stringify({
        p: last.pinned ? 1 : 0,
        c: last.createdAt.getTime(),
        i: last.id,
      }),
    ).toString('base64url')
  }

  return { items, nextCursor }
}

/** 解析并校验 keyset 游标；非法输入返回 null（从头分页） */
function parseCursor(cursor: string): {
  p: 0 | 1
  c: number
  i: string
} | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString(),
    )
    if (
      parsed &&
      typeof parsed === 'object' &&
      'p' in parsed &&
      'c' in parsed &&
      'i' in parsed
    ) {
      const { p, c, i } = parsed
      if (
        (p === 0 || p === 1) &&
        typeof c === 'number' &&
        Number.isFinite(c) &&
        typeof i === 'string' &&
        i.length > 0
      ) {
        return { p, c, i }
      }
    }
  } catch {
    return null
  }
  return null
}

// 解析标签路径 → 命中标签 id 集合（含子标签）
export async function resolveTagIds(
  userId: string,
  tagPath: string,
): Promise<string[]> {
  const segments = tagPathToSegments(tagPath)
  let parentId: string | null = null
  for (const seg of segments) {
    const cond: SQL | undefined =
      parentId === null
        ? and(
            eq(tags.userId, userId),
            eq(tags.name, seg),
            isNull(tags.parentId),
          )
        : and(
            eq(tags.userId, userId),
            eq(tags.name, seg),
            eq(tags.parentId, parentId),
          )
    const tag: typeof tags.$inferSelect | undefined =
      await db.query.tags.findFirst({
        where: cond,
      })
    if (!tag) return []
    parentId = tag.id
  }
  if (!parentId) return []
  // 收集所有层级后代（BFS，支持任意深度）
  const ids = new Set<string>([parentId])
  const queue = [parentId]
  while (queue.length > 0) {
    const current = queue.shift()!
    const children = await db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.userId, userId), eq(tags.parentId, current)))
    for (const child of children) {
      if (!ids.has(child.id)) {
        ids.add(child.id)
        queue.push(child.id)
      }
    }
  }
  return [...ids]
}

// ── update ───────────────────────────────────────────────
export async function updateMemoForUser(
  userId: string,
  id: string,
  content: string,
): Promise<MemoWithTags> {
  const now = new Date()

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(memos)
      .set({ content, updatedAt: now })
      .where(and(eq(memos.id, id), eq(memos.userId, userId)))
      .returning()
    if (updated.length === 0) throw new Error('memo not found')
    await syncTagsForContent(tx, userId, id, content)
    await cleanupOrphanTags(tx, userId)
  })

  const memo = await db.query.memos.findFirst({
    where: and(eq(memos.id, id), eq(memos.userId, userId)),
  })
  if (!memo) throw new Error('memo not found')
  const [tagRows, countsMap, viewerMap] = await Promise.all([
    loadMemoTags([memo.id]),
    loadMemoCounts([memo.id]),
    loadViewerStates([memo.id], userId),
  ])
  return toMemoWithTags(
    memo,
    tagRows,
    countsMap.get(memo.id),
    viewerMap.get(memo.id),
  )
}

// ── get ─────────────────────────────────────────────────
export async function getMemoForUser(
  userId: string,
  id: string,
): Promise<MemoWithTags> {
  const memo = await db.query.memos.findFirst({
    where: and(eq(memos.id, id), eq(memos.userId, userId)),
  })
  if (!memo) throw new Error('memo not found')
  const [tagRows, countsMap, viewerMap] = await Promise.all([
    loadMemoTags([memo.id]),
    loadMemoCounts([memo.id]),
    loadViewerStates([memo.id], userId),
  ])
  return toMemoWithTags(
    memo,
    tagRows,
    countsMap.get(memo.id),
    viewerMap.get(memo.id),
  )
}

// ── delete ───────────────────────────────────────────────
export async function deleteMemoForUser(
  userId: string,
  id: string,
): Promise<{ deleted: boolean }> {
  let deleted = false
  await db.transaction(async (tx) => {
    const res = await tx
      .delete(memos)
      .where(and(eq(memos.id, id), eq(memos.userId, userId)))
      .returning()
    deleted = res.length > 0
    if (deleted) await cleanupOrphanTags(tx, userId)
  })
  return { deleted }
}

// ── togglePin / toggleArchive ────────────────────────────
export async function togglePinForUser(
  userId: string,
  id: string,
): Promise<{ pinned: boolean }> {
  const memo = await db.query.memos.findFirst({
    where: and(eq(memos.id, id), eq(memos.userId, userId)),
    columns: { pinned: true },
  })
  if (!memo) throw new Error('memo not found')
  return setPinForUser(userId, id, !memo.pinned)
}

export async function toggleArchiveForUser(
  userId: string,
  id: string,
): Promise<{ archived: boolean }> {
  const memo = await db.query.memos.findFirst({
    where: and(eq(memos.id, id), eq(memos.userId, userId)),
  })
  if (!memo) throw new Error('memo not found')
  const nextArchived = !memo.archived
  const [updated] = await db
    .update(memos)
    .set({
      archived: nextArchived,
      ...(nextArchived ? { globalPinned: false } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(memos.id, id), eq(memos.userId, userId)))
    .returning()
  return { archived: updated.archived }
}

export async function setVisibilityForUser(
  userId: string,
  id: string,
  visibility: 'public' | 'private',
): Promise<{ visibility: 'public' | 'private' }> {
  const memo = await db.query.memos.findFirst({
    where: and(eq(memos.id, id), eq(memos.userId, userId)),
  })
  if (!memo) throw new Error('memo not found')
  const [updated] = await db
    .update(memos)
    .set({
      visibility,
      ...(visibility === 'private' ? { globalPinned: false } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(memos.id, id), eq(memos.userId, userId)))
    .returning()
  return { visibility: updated.visibility }
}

export async function setPinForUser(
  userId: string,
  id: string,
  pinned: boolean,
): Promise<{ pinned: boolean }> {
  return db.transaction(async (tx) => {
    const memo = await tx.query.memos.findFirst({
      where: and(eq(memos.id, id), eq(memos.userId, userId)),
      columns: { id: true, pinned: true },
    })
    if (!memo) throw new Error('memo not found')
    if (memo.pinned === pinned) return { pinned }

    const now = new Date()
    if (pinned) {
      await tx
        .update(memos)
        .set({ pinned: false, updatedAt: now })
        .where(and(eq(memos.userId, userId), eq(memos.pinned, true)))
    }
    const [updated] = await tx
      .update(memos)
      .set({ pinned, updatedAt: now })
      .where(and(eq(memos.id, id), eq(memos.userId, userId)))
      .returning({ pinned: memos.pinned })
    return { pinned: updated.pinned }
  })
}

export async function toggleGlobalPinForAdmin(
  id: string,
): Promise<{ globalPinned: boolean }> {
  return db.transaction(async (tx) => {
    const memo = await tx.query.memos.findFirst({
      where: eq(memos.id, id),
      columns: {
        id: true,
        visibility: true,
        archived: true,
        globalPinned: true,
      },
    })
    if (!memo) throw new Error('memo not found')

    const globalPinned = !memo.globalPinned
    if (globalPinned && (memo.visibility !== 'public' || memo.archived)) {
      throw new Error('只能全局置顶公开且未归档的 memo')
    }

    const now = new Date()
    if (globalPinned) {
      await tx
        .update(memos)
        .set({ globalPinned: false, updatedAt: now })
        .where(eq(memos.globalPinned, true))
    }
    const [updated] = await tx
      .update(memos)
      .set({ globalPinned, updatedAt: now })
      .where(eq(memos.id, id))
      .returning({ globalPinned: memos.globalPinned })
    return { globalPinned: updated.globalPinned }
  })
}

export async function setArchiveForUser(
  userId: string,
  id: string,
  archived: boolean,
): Promise<{ archived: boolean }> {
  const updated = await db
    .update(memos)
    .set({
      archived,
      ...(archived ? { globalPinned: false } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(memos.id, id), eq(memos.userId, userId)))
    .returning()
  if (updated.length === 0) throw new Error('memo not found')
  return { archived: updated[0].archived }
}

// ── 导出 / 导入 ─────────────────────────────────────────
export interface MemoExportItem {
  id: string
  content: string
  visibility: 'public' | 'private'
  pinned: boolean
  archived: boolean
  createdAt: string
  updatedAt: string
  tags: string[]
}

export interface MemoImportItem {
  id?: string
  content: string
  visibility: 'public' | 'private'
  pinned: boolean
  archived: boolean
  createdAt?: string
  updatedAt?: string
  tags?: string[]
}

export async function exportMemosForUser(
  userId: string,
): Promise<MemoExportItem[]> {
  const rows = await db
    .select()
    .from(memos)
    .where(eq(memos.userId, userId))
    .orderBy(asc(memos.createdAt))
  const tagRows = await loadMemoTags(rows.map((m) => m.id))
  const tagByMemo = new Map<string, string[]>()
  for (const t of tagRows) {
    const list = tagByMemo.get(t.memoId) ?? []
    list.push(t.tagName)
    tagByMemo.set(t.memoId, list)
  }
  return rows.map((m) => ({
    id: m.id,
    content: m.content,
    visibility: m.visibility,
    pinned: m.pinned,
    archived: m.archived,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    tags: tagByMemo.get(m.id) ?? [],
  }))
}

export async function importMemosForUser(
  userId: string,
  items: MemoImportItem[],
): Promise<{ imported: number; skipped: number }> {
  let imported = 0
  let skipped = 0
  let requestedPinId: string | null = null
  const candidateIds = items
    .map((i) => i.id)
    .filter((x): x is string => Boolean(x))
  const existingIds = new Set(
    (
      await db
        .select({ id: memos.id })
        .from(memos)
        .where(inArray(memos.id, candidateIds))
    ).map((r) => r.id),
  )

  await db.transaction(async (tx) => {
    for (const item of items) {
      if (item.id && existingIds.has(item.id)) {
        skipped++
        continue
      }
      const createdAt = new Date(item.createdAt ?? '')
      const updatedAt = new Date(item.updatedAt ?? '')
      const createdAtValue = Number.isNaN(createdAt.getTime())
        ? new Date()
        : createdAt
      const id = item.id || ulid()
      await tx.insert(memos).values({
        id,
        userId,
        content: item.content,
        visibility: item.visibility,
        pinned: false,
        archived: item.archived,
        createdAt: createdAtValue,
        updatedAt:
          Number.isNaN(updatedAt.getTime()) || updatedAt < createdAt
            ? createdAtValue
            : updatedAt,
      })
      // 复用标签同步逻辑（基于 content 重新解析，忽略导出文件里的 tags 字段）
      await syncTagsForContent(tx, userId, id, item.content)
      if (item.pinned) requestedPinId = id
      imported++
    }
    if (requestedPinId) {
      await tx
        .update(memos)
        .set({ pinned: false, updatedAt: new Date() })
        .where(and(eq(memos.userId, userId), eq(memos.pinned, true)))
      await tx
        .update(memos)
        .set({ pinned: true, updatedAt: new Date() })
        .where(and(eq(memos.id, requestedPinId), eq(memos.userId, userId)))
    }
    await cleanupOrphanTags(tx, userId)
  })
  return { imported, skipped }
}

// ── stats ────────────────────────────────────────────────
// 随机抽 n 条历史 memo（每日回顾）
export async function getRandomMemosForUser(
  userId: string,
  n = 8,
): Promise<MemoWithTags[]> {
  const rows = await db
    .select()
    .from(memos)
    .where(and(eq(memos.userId, userId), eq(memos.archived, false)))
    .orderBy(sql`random()`)
    .limit(n)
  const tagRows = await loadMemoTags(rows.map((m) => m.id))
  return rows.map((m) => toMemoWithTags(m, tagRows))
}

function localDayKey(ms: number, tzOffsetMinutes: number): string {
  const d = new Date(ms - tzOffsetMinutes * 60_000)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}-${mm}-${dd}`
}

export async function getStatsForUser(
  userId: string,
  tzOffsetMinutes = new Date().getTimezoneOffset(),
): Promise<{
  total: number
  streak: number
}> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(memos)
    .where(and(eq(memos.userId, userId), eq(memos.archived, false)))
  // 连续记录天数：从最近一条往前数，要求每天（本地时区）至少一条
  const days = await db
    .select({ createdAt: memos.createdAt })
    .from(memos)
    .where(and(eq(memos.userId, userId), eq(memos.archived, false)))
    .orderBy(desc(memos.createdAt))
    .limit(3650)
  const daySet = new Set(
    days.map((d) => localDayKey(d.createdAt.getTime(), tzOffsetMinutes)),
  )
  let streak = 0
  let cursor = Date.now()
  while (daySet.has(localDayKey(cursor, tzOffsetMinutes))) {
    streak++
    cursor -= 86_400_000
  }
  return { total, streak }
}

export interface ContributionDay {
  date: string
  count: number
}

export interface ContributionMonthData {
  /** 当前展示的月份（YYYY-MM，已夹取到可选范围内） */
  month: string
  /** 最老一条 memo 所在月份 */
  minMonth: string
  /** 当前月份 */
  maxMonth: string
  /** 当月未归档 memo 总数 */
  total: number
  /** 当月每天（YYYY-MM-DD）的 memo 数量，按日期升序 */
  days: ContributionDay[]
}

function monthKeyLocal(ms: number, tzOffsetMinutes: number): string {
  const d = new Date(ms - tzOffsetMinutes * 60_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function parseMonthKey(key: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  return { year, month }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * 贡献图数据：按月返回每天的未归档 memo 数量。
 * 可选月份范围以用户最老一条 memo 所在月份为起点、当前月份为终点；
 * 请求的月份不在范围内时自动夹取到最近的合法月份。
 */
export async function getContributionForUser(
  userId: string,
  opts: { month?: string; tzOffsetMinutes?: number } = {},
): Promise<ContributionMonthData> {
  const tzOffsetMinutes = opts.tzOffsetMinutes ?? new Date().getTimezoneOffset()
  const maxMonth = monthKeyLocal(Date.now(), tzOffsetMinutes)

  const oldest = await db.query.memos.findFirst({
    where: eq(memos.userId, userId),
    columns: { createdAt: true },
    orderBy: [asc(memos.createdAt)],
  })
  const minMonth = oldest
    ? monthKeyLocal(oldest.createdAt.getTime(), tzOffsetMinutes)
    : maxMonth

  const requested = parseMonthKey(opts.month ?? '')
  let month = requested ? opts.month! : maxMonth
  if (month < minMonth) month = minMonth
  if (month > maxMonth) month = maxMonth

  const parsed = parseMonthKey(month)!
  const start =
    Date.UTC(parsed.year, parsed.month - 1, 1) + tzOffsetMinutes * 60_000
  const end = Date.UTC(parsed.year, parsed.month, 1) + tzOffsetMinutes * 60_000
  const rows = await db
    .select({ createdAt: memos.createdAt })
    .from(memos)
    .where(
      and(
        eq(memos.userId, userId),
        eq(memos.archived, false),
        gte(memos.createdAt, new Date(start)),
        lt(memos.createdAt, new Date(end)),
      ),
    )

  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = localDayKey(row.createdAt.getTime(), tzOffsetMinutes)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const days: ContributionDay[] = []
  let total = 0
  const dayCount = daysInMonth(parsed.year, parsed.month)
  for (let d = 1; d <= dayCount; d++) {
    const key = `${month}-${String(d).padStart(2, '0')}`
    const dayTotal = counts.get(key) ?? 0
    total += dayTotal
    days.push({ date: key, count: dayTotal })
  }
  return { month, minMonth, maxMonth, total, days }
}
