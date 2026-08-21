import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { db } from '#/db'
import {
  memoFavorites,
  memoLinks,
  memoReviewEvents,
  memoVersions,
  memos,
  memoTags,
  tags,
} from '#/db/schema'
import { parseHashtags, tagPathToSegments } from '#/lib/hashtags'
import { parseMemoReferences } from '#/lib/memo-links'
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
  deletedAt: string | null
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
  filter?: 'all' | 'archived' | 'deleted'
  visibility?: 'public' | 'private'
  favorited?: boolean
  from?: string
  to?: string
  tzOffsetMinutes?: number
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
    deletedAt: memo.deletedAt?.toISOString() ?? null,
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

async function syncRelationsForContent(
  tx: Tx,
  userId: string,
  memoId: string,
  content: string,
): Promise<void> {
  await tx.delete(memoTags).where(eq(memoTags.memoId, memoId))
  await tx.delete(memoLinks).where(eq(memoLinks.sourceId, memoId))
  await syncImportedRelations(tx, userId, [{ id: memoId, content }])
}

function chunks<T>(items: T[], size = 250): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size))
  }
  return result
}

async function syncImportedRelations(
  tx: Tx,
  userId: string,
  imported: Array<{ id: string; content: string }>,
): Promise<void> {
  if (imported.length === 0) return

  const pathsByMemo = imported.map((memo) => ({
    id: memo.id,
    paths: parseHashtags(memo.content).map(tagPathToSegments),
  }))
  const maxDepth = Math.max(
    0,
    ...pathsByMemo.flatMap((memo) => memo.paths.map((path) => path.length)),
  )
  const tagIdByPath = new Map<string, string>()

  for (let depth = 0; depth < maxDepth; depth++) {
    const candidates = new Map<
      string,
      { id: string; name: string; parentId: string | null }
    >()
    for (const memo of pathsByMemo) {
      for (const path of memo.paths) {
        if (path.length <= depth) continue
        const pathKey = path.slice(0, depth + 1).join('\0')
        const parentId =
          depth === 0 ? null : tagIdByPath.get(path.slice(0, depth).join('\0'))
        if (parentId === undefined) throw new Error('tag parent not found')
        if (!candidates.has(pathKey)) {
          candidates.set(pathKey, {
            id: crypto.randomUUID(),
            name: path[depth],
            parentId,
          })
        }
      }
    }
    for (const batch of chunks([...candidates.values()])) {
      await tx
        .insert(tags)
        .values(
          batch.map((tag) => ({
            ...tag,
            userId,
            createdAt: new Date(),
          })),
        )
        .onConflictDoNothing()
    }
    const storedTags = await tx
      .select()
      .from(tags)
      .where(eq(tags.userId, userId))
    const storedByParentAndName = new Map(
      storedTags.map((tag) => [`${tag.parentId ?? ''}\0${tag.name}`, tag.id]),
    )
    for (const [pathKey, candidate] of candidates) {
      const storedId = storedByParentAndName.get(
        `${candidate.parentId ?? ''}\0${candidate.name}`,
      )
      if (!storedId) throw new Error('tag create conflict')
      tagIdByPath.set(pathKey, storedId)
    }
  }

  const memoTagValues: Array<typeof memoTags.$inferInsert> = []
  const memoTagKeys = new Set<string>()
  for (const memo of pathsByMemo) {
    for (const path of memo.paths) {
      const tagId = tagIdByPath.get(path.join('\0'))
      if (tagId) {
        const key = `${memo.id}\0${tagId}`
        if (!memoTagKeys.has(key)) {
          memoTagKeys.add(key)
          memoTagValues.push({ memoId: memo.id, tagId })
        }
      }
    }
  }
  for (const batch of chunks(memoTagValues)) {
    await tx.insert(memoTags).values(batch).onConflictDoNothing()
  }

  const references = new Map(
    imported.map((memo) => [
      memo.id,
      parseMemoReferences(memo.content).filter((id) => id !== memo.id),
    ]),
  )
  const targetIds = [...new Set([...references.values()].flat())]
  const validTargetIds = new Set<string>()
  for (const batch of chunks(targetIds, 500)) {
    const targets = await tx
      .select({ id: memos.id })
      .from(memos)
      .where(
        and(
          eq(memos.userId, userId),
          isNull(memos.deletedAt),
          inArray(memos.id, batch),
        ),
      )
    for (const target of targets) validTargetIds.add(target.id)
  }
  const now = new Date()
  const links = [...references].flatMap(([sourceId, ids]) =>
    ids
      .filter((targetId) => validTargetIds.has(targetId))
      .map((targetId) => ({ sourceId, targetId, createdAt: now })),
  )
  for (const batch of chunks(links)) {
    await tx.insert(memoLinks).values(batch).onConflictDoNothing()
  }
}

function contentSearchCondition(query: string): SQL {
  const phrase = `"${query.trim().replace(/"/g, '""')}"`
  return sql`${memos.id} IN (
    SELECT id FROM memos_fts WHERE memos_fts MATCH ${phrase}
  )`
}

function localDateBoundary(
  value: string,
  tzOffsetMinutes: number,
  addDays = 0,
): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const ms =
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]) + addDays,
    ) +
    tzOffsetMinutes * 60_000
  return new Date(ms)
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
  opts: { visibility?: 'public' | 'private'; clientId?: string } = {},
): Promise<MemoWithTags> {
  const now = new Date()
  const memo = {
    id: ulid(),
    userId,
    content,
    clientId: opts.clientId ?? null,
    visibility: opts.visibility ?? 'private',
    pinned: false,
    globalPinned: false,
    archived: false,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  }

  const saved = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(memos)
      .values(memo)
      .onConflictDoNothing()
      .returning()
    if (inserted.length === 0) {
      const existing = opts.clientId
        ? await tx.query.memos.findFirst({
            where: and(
              eq(memos.userId, userId),
              eq(memos.clientId, opts.clientId),
            ),
          })
        : undefined
      if (!existing) throw new Error('memo create conflict')
      return existing
    }
    await syncRelationsForContent(tx, userId, memo.id, content)
    return inserted[0]
  })

  const [tagRows, countsMap, viewerMap] = await Promise.all([
    loadMemoTags([saved.id]),
    loadMemoCounts([saved.id]),
    loadViewerStates([saved.id], userId),
  ])
  return toMemoWithTags(
    saved,
    tagRows,
    countsMap.get(saved.id),
    viewerMap.get(saved.id),
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
  if (params.filter === 'deleted') {
    conditions.push(isNotNull(memos.deletedAt))
  } else {
    conditions.push(isNull(memos.deletedAt))
  }
  if (params.filter === 'archived') {
    conditions.push(eq(memos.archived, true))
  } else if (params.filter !== 'deleted') {
    conditions.push(eq(memos.archived, false))
  }
  if (params.q) {
    conditions.push(contentSearchCondition(params.q))
  }
  if (params.visibility) {
    conditions.push(eq(memos.visibility, params.visibility))
  }
  if (params.favorited) {
    const favoriteIds = db
      .select({ memoId: memoFavorites.memoId })
      .from(memoFavorites)
      .where(eq(memoFavorites.userId, userId))
    conditions.push(inArray(memos.id, favoriteIds))
  }
  const tzOffsetMinutes = params.tzOffsetMinutes ?? 0
  if (params.from) {
    const from = localDateBoundary(params.from, tzOffsetMinutes)
    if (from) conditions.push(gte(memos.createdAt, from))
  }
  if (params.to) {
    const to = localDateBoundary(params.to, tzOffsetMinutes, 1)
    if (to) conditions.push(lt(memos.createdAt, to))
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
        params.filter === 'deleted'
          ? [
              lt(memos.deletedAt, cDate),
              and(eq(memos.deletedAt, cDate), lt(memos.id, cur.i)),
            ]
          : cur.p === 1
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
    .orderBy(
      ...(params.filter === 'deleted'
        ? [desc(memos.deletedAt), desc(memos.id)]
        : [desc(memos.pinned), desc(memos.createdAt), desc(memos.id)]),
    )
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const memoIds = page.map((m) => m.id)
  const [tagRows, countsMap, viewerMap] = await Promise.all([
    loadMemoTags(memoIds),
    loadMemoCounts(memoIds),
    loadViewerStates(memoIds, viewerId),
  ])
  const tagsByMemo = new Map<string, typeof tagRows>()
  for (const tag of tagRows) {
    const list = tagsByMemo.get(tag.memoId) ?? []
    list.push(tag)
    tagsByMemo.set(tag.memoId, list)
  }
  const items = page.map((m) =>
    toMemoWithTags(
      m,
      tagsByMemo.get(m.id) ?? [],
      countsMap.get(m.id),
      viewerMap.get(m.id),
    ),
  )
  const last = page[page.length - 1]
  let nextCursor: string | null = null
  if (hasMore) {
    nextCursor = Buffer.from(
      JSON.stringify({
        p: params.filter === 'deleted' ? 0 : last.pinned ? 1 : 0,
        c:
          params.filter === 'deleted'
            ? last.deletedAt!.getTime()
            : last.createdAt.getTime(),
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
  if (cursor.length > 256) return null
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
  return patchMemoForUser(userId, id, { content })
}

export async function patchMemoForUser(
  userId: string,
  id: string,
  patch: {
    content?: string
    visibility?: 'public' | 'private'
    pinned?: boolean
    archived?: boolean
  },
): Promise<MemoWithTags> {
  const now = new Date()

  await db.transaction(async (tx) => {
    const current = await tx.query.memos.findFirst({
      where: and(
        eq(memos.id, id),
        eq(memos.userId, userId),
        isNull(memos.deletedAt),
      ),
    })
    if (!current) throw new Error('memo not found')
    const contentChanged =
      patch.content !== undefined && patch.content !== current.content
    if (contentChanged) {
      await tx.insert(memoVersions).values({
        id: ulid(),
        userId,
        memoId: id,
        content: current.content,
        createdAt: now,
      })
    }
    if (patch.pinned === true && !current.pinned) {
      await tx
        .update(memos)
        .set({ pinned: false, updatedAt: now })
        .where(and(eq(memos.userId, userId), eq(memos.pinned, true)))
    }
    const updated = await tx
      .update(memos)
      .set({
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.visibility !== undefined
          ? { visibility: patch.visibility }
          : {}),
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
        ...(patch.visibility === 'private' || patch.archived === true
          ? { globalPinned: false }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(memos.id, id),
          eq(memos.userId, userId),
          isNull(memos.deletedAt),
        ),
      )
      .returning()
    if (updated.length === 0) throw new Error('memo not found')
    if (contentChanged) {
      await syncRelationsForContent(tx, userId, id, patch.content!)
      await cleanupOrphanTags(tx, userId)
    }
  })

  return getMemoForUser(userId, id)
}

// ── get ─────────────────────────────────────────────────
async function loadMemosForUserByIds(
  userId: string,
  ids: string[],
): Promise<Map<string, MemoWithTags>> {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return new Map()
  const rows = await db
    .select()
    .from(memos)
    .where(
      and(
        eq(memos.userId, userId),
        isNull(memos.deletedAt),
        inArray(memos.id, uniqueIds),
      ),
    )
  const [tagRows, countsMap, viewerMap] = await Promise.all([
    loadMemoTags(uniqueIds),
    loadMemoCounts(uniqueIds),
    loadViewerStates(uniqueIds, userId),
  ])
  const tagsByMemo = new Map<string, typeof tagRows>()
  for (const tag of tagRows) {
    const list = tagsByMemo.get(tag.memoId) ?? []
    list.push(tag)
    tagsByMemo.set(tag.memoId, list)
  }
  return new Map(
    rows.map((memo) => [
      memo.id,
      toMemoWithTags(
        memo,
        tagsByMemo.get(memo.id) ?? [],
        countsMap.get(memo.id),
        viewerMap.get(memo.id),
      ),
    ]),
  )
}

export async function getMemoForUser(
  userId: string,
  id: string,
): Promise<MemoWithTags> {
  const memo = (await loadMemosForUserByIds(userId, [id])).get(id)
  if (!memo) throw new Error('memo not found')
  return memo
}

export interface MemoConnections {
  outgoing: MemoWithTags[]
  backlinks: MemoWithTags[]
  related: MemoWithTags[]
}

export async function getMemoConnectionsForUser(
  userId: string,
  memoId: string,
): Promise<MemoConnections> {
  const memo = await db.query.memos.findFirst({
    where: and(
      eq(memos.id, memoId),
      eq(memos.userId, userId),
      isNull(memos.deletedAt),
    ),
    columns: { id: true },
  })
  if (!memo) throw new Error('memo not found')
  const [outgoingRows, backlinkRows, tagRows] = await Promise.all([
    db
      .select({ id: memoLinks.targetId })
      .from(memoLinks)
      .where(eq(memoLinks.sourceId, memoId))
      .limit(20),
    db
      .select({ id: memoLinks.sourceId })
      .from(memoLinks)
      .where(eq(memoLinks.targetId, memoId))
      .limit(20),
    db
      .select({ tagId: memoTags.tagId })
      .from(memoTags)
      .where(eq(memoTags.memoId, memoId)),
  ])

  const relatedRows =
    tagRows.length === 0
      ? []
      : await db
          .select({ id: memos.id })
          .from(memoTags)
          .innerJoin(memos, eq(memos.id, memoTags.memoId))
          .where(
            and(
              inArray(
                memoTags.tagId,
                tagRows.map((row) => row.tagId),
              ),
              eq(memos.userId, userId),
              eq(memos.archived, false),
              isNull(memos.deletedAt),
              ne(memos.id, memoId),
            ),
          )
          .groupBy(memos.id)
          .orderBy(desc(count(memoTags.tagId)), desc(memos.createdAt))
          .limit(8)

  const outgoingIds = outgoingRows.map((row) => row.id)
  const backlinkIds = backlinkRows.map((row) => row.id)
  const relatedIds = relatedRows.map((row) => row.id)
  const memoById = await loadMemosForUserByIds(userId, [
    ...outgoingIds,
    ...backlinkIds,
    ...relatedIds,
  ])
  function pick(ids: string[]): MemoWithTags[] {
    return ids
      .map((id) => memoById.get(id))
      .filter((item): item is MemoWithTags => Boolean(item))
  }
  return {
    outgoing: pick(outgoingIds),
    backlinks: pick(backlinkIds),
    related: pick(relatedIds),
  }
}

export type ReviewMode = 'random' | 'on-this-day' | 'least-reviewed'

export async function getReviewMemosForUser(
  userId: string,
  opts: {
    mode: ReviewMode
    n?: number
    tag?: string
    tzOffsetMinutes?: number
  },
): Promise<MemoWithTags[]> {
  const limit = Math.min(opts.n ?? 8, 20)
  const conditions = [
    eq(memos.userId, userId),
    eq(memos.archived, false),
    isNull(memos.deletedAt),
  ]
  if (opts.tag) {
    const tagIds = await resolveTagIds(userId, opts.tag)
    if (tagIds.length === 0) return []
    const taggedMemoIds = db
      .select({ memoId: memoTags.memoId })
      .from(memoTags)
      .where(inArray(memoTags.tagId, tagIds))
    conditions.push(inArray(memos.id, taggedMemoIds))
  }
  if (opts.mode === 'on-this-day') {
    const offset = opts.tzOffsetMinutes ?? 0
    const localNow = new Date(Date.now() - offset * 60_000)
    const monthDay = `${String(localNow.getUTCMonth() + 1).padStart(2, '0')}-${String(localNow.getUTCDate()).padStart(2, '0')}`
    const modifier = `${-offset} minutes`
    conditions.push(
      sql`strftime('%m-%d', ${memos.createdAt} / 1000, 'unixepoch', ${modifier}) = ${monthDay}`,
    )
  }

  let query = db
    .select()
    .from(memos)
    .where(and(...conditions))
    .$dynamic()
  query =
    opts.mode === 'random'
      ? query.orderBy(sql`random()`)
      : opts.mode === 'least-reviewed'
        ? query.orderBy(
            sql`(SELECT count(*) FROM memo_review_events review WHERE review.memo_id = ${memos.id})`,
            sql`(SELECT max(reviewed_at) FROM memo_review_events review WHERE review.memo_id = ${memos.id}) ASC`,
            desc(memos.createdAt),
          )
        : query.orderBy(desc(memos.createdAt))

  const rows = await query.limit(limit)
  if (rows.length > 0) {
    const now = new Date()
    await db.insert(memoReviewEvents).values(
      rows.map((memo) => ({
        id: ulid(),
        userId,
        memoId: memo.id,
        reviewedAt: now,
      })),
    )
  }
  const tagData = await loadMemoTags(rows.map((memo) => memo.id))
  return rows.map((memo) =>
    toMemoWithTags(
      memo,
      tagData.filter((tag) => tag.memoId === memo.id),
    ),
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
      .update(memos)
      .set({
        deletedAt: new Date(),
        pinned: false,
        globalPinned: false,
        archived: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(memos.id, id),
          eq(memos.userId, userId),
          isNull(memos.deletedAt),
        ),
      )
      .returning()
    deleted = res.length > 0
  })
  return { deleted }
}

export async function restoreDeletedMemoForUser(
  userId: string,
  id: string,
): Promise<{ restored: boolean }> {
  const restored = await db
    .update(memos)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(memos.id, id),
        eq(memos.userId, userId),
        isNotNull(memos.deletedAt),
      ),
    )
    .returning({ id: memos.id })
  return { restored: restored.length > 0 }
}

export async function purgeMemoForUser(
  userId: string,
  id: string,
): Promise<{ deleted: boolean }> {
  let deleted = false
  await db.transaction(async (tx) => {
    const rows = await tx
      .delete(memos)
      .where(
        and(
          eq(memos.id, id),
          eq(memos.userId, userId),
          isNotNull(memos.deletedAt),
        ),
      )
      .returning({ id: memos.id })
    deleted = rows.length > 0
    if (deleted) await cleanupOrphanTags(tx, userId)
  })
  return { deleted }
}

export interface MemoVersionItem {
  id: string
  content: string
  createdAt: string
}

export async function listMemoVersionsForUser(
  userId: string,
  memoId: string,
): Promise<MemoVersionItem[]> {
  await getMemoForUser(userId, memoId)
  const rows = await db
    .select()
    .from(memoVersions)
    .where(
      and(eq(memoVersions.userId, userId), eq(memoVersions.memoId, memoId)),
    )
    .orderBy(desc(memoVersions.createdAt))
    .limit(50)
  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  }))
}

export async function restoreMemoVersionForUser(
  userId: string,
  memoId: string,
  versionId: string,
): Promise<MemoWithTags> {
  const version = await db.query.memoVersions.findFirst({
    where: and(
      eq(memoVersions.id, versionId),
      eq(memoVersions.memoId, memoId),
      eq(memoVersions.userId, userId),
    ),
  })
  if (!version) throw new Error('memo version not found')
  return updateMemoForUser(userId, memoId, version.content)
}

// ── togglePin / toggleArchive ────────────────────────────
export async function togglePinForUser(
  userId: string,
  id: string,
): Promise<{ pinned: boolean }> {
  const memo = await db.query.memos.findFirst({
    where: and(
      eq(memos.id, id),
      eq(memos.userId, userId),
      isNull(memos.deletedAt),
    ),
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
    where: and(
      eq(memos.id, id),
      eq(memos.userId, userId),
      isNull(memos.deletedAt),
    ),
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
    .where(
      and(eq(memos.id, id), eq(memos.userId, userId), isNull(memos.deletedAt)),
    )
    .returning()
  return { archived: updated.archived }
}

export async function setVisibilityForUser(
  userId: string,
  id: string,
  visibility: 'public' | 'private',
): Promise<{ visibility: 'public' | 'private' }> {
  const memo = await db.query.memos.findFirst({
    where: and(
      eq(memos.id, id),
      eq(memos.userId, userId),
      isNull(memos.deletedAt),
    ),
  })
  if (!memo) throw new Error('memo not found')
  const [updated] = await db
    .update(memos)
    .set({
      visibility,
      ...(visibility === 'private' ? { globalPinned: false } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(eq(memos.id, id), eq(memos.userId, userId), isNull(memos.deletedAt)),
    )
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
      where: and(
        eq(memos.id, id),
        eq(memos.userId, userId),
        isNull(memos.deletedAt),
      ),
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
      where: and(eq(memos.id, id), isNull(memos.deletedAt)),
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
    .where(
      and(eq(memos.id, id), eq(memos.userId, userId), isNull(memos.deletedAt)),
    )
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
    .where(and(eq(memos.userId, userId), isNull(memos.deletedAt)))
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
  let skipped = 0
  const seenIds = new Set<string>()
  const prepared: Array<{
    item: MemoImportItem
    memo: typeof memos.$inferInsert
  }> = []
  for (const item of items) {
    const id = item.id || ulid()
    if (seenIds.has(id)) {
      skipped++
      continue
    }
    seenIds.add(id)
    const createdAt = new Date(item.createdAt ?? '')
    const updatedAt = new Date(item.updatedAt ?? '')
    const createdAtValue = Number.isNaN(createdAt.getTime())
      ? new Date()
      : createdAt
    prepared.push({
      item,
      memo: {
        id,
        userId,
        content: item.content,
        visibility: item.visibility,
        pinned: false,
        archived: item.archived,
        createdAt: createdAtValue,
        updatedAt:
          Number.isNaN(updatedAt.getTime()) || updatedAt < createdAtValue
            ? createdAtValue
            : updatedAt,
      },
    })
  }

  const imported = await db.transaction(async (tx) => {
    const insertedIds = new Set<string>()
    for (const batch of chunks(prepared)) {
      const inserted = await tx
        .insert(memos)
        .values(batch.map(({ memo }) => memo))
        .onConflictDoNothing()
        .returning({ id: memos.id })
      for (const row of inserted) insertedIds.add(row.id)
    }
    const accepted = prepared.filter(({ memo }) => insertedIds.has(memo.id))
    skipped += prepared.length - accepted.length
    await syncImportedRelations(
      tx,
      userId,
      accepted.map(({ memo }) => ({ id: memo.id, content: memo.content })),
    )

    const requestedPinId = [...accepted]
      .reverse()
      .find(({ item }) => item.pinned)?.memo.id
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
    return accepted.length
  })
  return { imported, skipped }
}

// ── stats ────────────────────────────────────────────────
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
    .where(
      and(
        eq(memos.userId, userId),
        eq(memos.archived, false),
        isNull(memos.deletedAt),
      ),
    )
  // 连续记录天数：从最近一条往前数，要求每天（本地时区）至少一条
  const modifier = `${-tzOffsetMinutes} minutes`
  const localDay = sql<string>`strftime('%Y-%m-%d', ${memos.createdAt} / 1000, 'unixepoch', ${modifier})`
  const days = await db
    .selectDistinct({ day: localDay })
    .from(memos)
    .where(
      and(
        eq(memos.userId, userId),
        eq(memos.archived, false),
        isNull(memos.deletedAt),
      ),
    )
    .orderBy(desc(localDay))
  const daySet = new Set(days.map((d) => d.day))
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
    where: and(eq(memos.userId, userId), isNull(memos.deletedAt)),
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
        isNull(memos.deletedAt),
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
