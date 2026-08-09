import { and, count, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm'

import { db } from '#/db'
import { memoReposts, memos, memoTags, user } from '#/db/schema'
import { resolveAvatarUrl } from '#/lib/avatar'
import { loadMemoCounts, loadViewerStates } from './interactions-core'
import { loadMemoTags, toMemoWithTags } from './memos-core'
import type { MemoWithTags } from './memos-core'
import { loadMemoAuthors, resolveGlobalTagIds } from './timeline-core'
import type { MemoAuthor, TimelineItem } from './timeline-core'

export interface PublicProfile {
  id: string
  username: string
  name: string
  bio: string | null
  image: string | null
  createdAt: string
  stats: {
    memos: number
    reposts: number
  }
}

/** 公共主页时间线（个人主页 = TimelineItem，含原作者与转发上下文） */
export type PublicFeedItem = TimelineItem

export interface PublicMemoDetail {
  memo: MemoWithTags
  author: {
    id: string
    username: string
    name: string
    image: string | null
  }
}

/** 公共主页聚合流（所有用户的公开 memo） */
export type PublicTimelineItem = TimelineItem

async function findUserByUsername(
  username: string,
): Promise<typeof user.$inferSelect | null> {
  return (
    (await db.query.user.findFirst({
      where: eq(user.username, username.toLowerCase().trim()),
    })) ?? null
  )
}

export async function getPublicProfileByUsername(
  username: string,
): Promise<PublicProfile | null> {
  const u = await findUserByUsername(username)
  if (!u) return null
  const [{ memos: memoCount }] = await db
    .select({ memos: count() })
    .from(memos)
    .where(
      and(
        eq(memos.userId, u.id),
        eq(memos.visibility, 'public'),
        eq(memos.archived, false),
        isNull(memos.deletedAt),
      ),
    )
  const repostRows = await db
    .select({ id: memoReposts.memoId })
    .from(memoReposts)
    .innerJoin(memos, eq(memos.id, memoReposts.memoId))
    .where(
      and(
        eq(memoReposts.userId, u.id),
        eq(memos.visibility, 'public'),
        eq(memos.archived, false),
        isNull(memos.deletedAt),
      ),
    )
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    bio: u.bio,
    image: resolveAvatarUrl(u.image, u.email),
    createdAt: u.createdAt.toISOString(),
    stats: {
      memos: memoCount,
      reposts: repostRows.length,
    },
  }
}

export async function listPublicFeed(
  username: string,
  opts: { cursor?: string; limit?: number; viewerId?: string | null } = {},
): Promise<{ items: PublicFeedItem[]; nextCursor: string | null }> {
  const u = await findUserByUsername(username)
  if (!u) return { items: [], nextCursor: null }
  const limit = Math.min(opts.limit ?? 20, 50)
  const cur = parseFeedCursor(opts.cursor)

  const memoConditions = [
    eq(memos.userId, u.id),
    eq(memos.visibility, 'public'),
    eq(memos.archived, false),
    isNull(memos.deletedAt),
    eq(memos.pinned, false),
  ]
  const repostConditions = [
    eq(memoReposts.userId, u.id),
    eq(memos.visibility, 'public'),
    eq(memos.archived, false),
    isNull(memos.deletedAt),
  ]
  if (cur?.p === 0) {
    if (cur.k !== 'repost') {
      const cond = or(
        lt(memos.createdAt, new Date(cur.t)),
        and(eq(memos.createdAt, new Date(cur.t)), lt(memos.id, cur.i)),
      )
      if (cond) memoConditions.push(cond)
    }
    if (cur.k !== 'memo') {
      const cond = or(
        lt(memoReposts.createdAt, new Date(cur.t)),
        and(
          eq(memoReposts.createdAt, new Date(cur.t)),
          lt(memoReposts.memoId, cur.i),
        ),
      )
      if (cond) repostConditions.push(cond)
    }
  }

  const pinnedRows = cur
    ? []
    : await db
        .select()
        .from(memos)
        .where(
          and(
            eq(memos.userId, u.id),
            eq(memos.visibility, 'public'),
            eq(memos.archived, false),
            isNull(memos.deletedAt),
            eq(memos.pinned, true),
          ),
        )
        .limit(1)
  const remaining = limit - pinnedRows.length

  const [memoRows, repostRows] = await Promise.all([
    db
      .select()
      .from(memos)
      .where(and(...memoConditions))
      .orderBy(desc(memos.createdAt), desc(memos.id))
      .limit(remaining + 1),
    db
      .select({
        memoId: memoReposts.memoId,
        content: memoReposts.content,
        createdAt: memoReposts.createdAt,
        memo: memos,
      })
      .from(memoReposts)
      .innerJoin(memos, eq(memos.id, memoReposts.memoId))
      .where(and(...repostConditions))
      .orderBy(desc(memoReposts.createdAt))
      .limit(remaining + 1),
  ])

  type Candidate = {
    p: 0 | 1
    t: number
    k: 'memo' | 'repost'
    i: string
    memoRow: typeof memos.$inferSelect
    repostRow: (typeof repostRows)[number] | null
  }
  const pinnedCandidates: Candidate[] = pinnedRows.map((m) => ({
    p: 1,
    t: m.createdAt.getTime(),
    k: 'memo',
    i: m.id,
    memoRow: m,
    repostRow: null,
  }))
  const candidates: Candidate[] = [
    ...memoRows.map((m) => ({
      p: 0 as const,
      t: m.createdAt.getTime(),
      k: 'memo' as const,
      i: m.id,
      memoRow: m,
      repostRow: null,
    })),
    ...repostRows.map((r) => ({
      p: 0 as const,
      t: r.createdAt.getTime(),
      k: 'repost' as const,
      i: r.memoId,
      memoRow: r.memo,
      repostRow: r,
    })),
  ]
  candidates.sort(
    (a, b) =>
      b.t - a.t ||
      (a.k === b.k ? b.i.localeCompare(a.i) : a.k === 'memo' ? -1 : 1),
  )
  const page = [...pinnedCandidates, ...candidates.slice(0, remaining)]
  const hasMore = candidates.length > remaining

  const memoIds = page.map((c) => c.memoRow.id)
  const [tagRows, countsMap, viewerMap, authorMap] = await Promise.all([
    loadMemoTags(memoIds),
    loadMemoCounts(memoIds),
    loadViewerStates(memoIds, opts.viewerId ?? null),
    loadMemoAuthors(memoIds),
  ])
  const tagByMemo = new Map<string, typeof tagRows>()
  for (const t of tagRows) {
    const list = tagByMemo.get(t.memoId) ?? []
    list.push(t)
    tagByMemo.set(t.memoId, list)
  }

  const items: PublicFeedItem[] = page.map((c) => {
    const counts = countsMap.get(c.memoRow.id)
    const viewerState = viewerMap.get(c.memoRow.id)
    const profileAuthor: MemoAuthor = {
      id: u.id,
      username: u.username,
      name: u.name,
      image: resolveAvatarUrl(u.image, u.email),
    }
    const originalAuthor = authorMap.get(c.memoRow.id) ?? profileAuthor
    return {
      kind: c.k,
      memo: toMemoWithTags(
        c.memoRow,
        tagByMemo.get(c.memoRow.id) ?? [],
        counts,
        viewerState,
      ),
      author: c.k === 'repost' ? originalAuthor : profileAuthor,
      repost: c.repostRow
        ? {
            content: c.repostRow.content,
            createdAt: c.repostRow.createdAt.toISOString(),
            reposter: profileAuthor,
          }
        : null,
    }
  })

  const last = page[page.length - 1]
  const nextCursor = hasMore
    ? Buffer.from(
        JSON.stringify({
          p: last.p,
          t: last.t,
          k: last.k,
          i: last.i,
        }),
      ).toString('base64url')
    : null
  return { items, nextCursor }
}

function parseFeedCursor(cursor?: string): {
  p: 0 | 1
  t: number
  k: 'memo' | 'repost'
  i: string
} | null {
  if (!cursor) return null
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString(),
    )
    if (
      parsed &&
      typeof parsed === 'object' &&
      't' in parsed &&
      'k' in parsed &&
      'i' in parsed
    ) {
      const p = 'p' in parsed ? parsed.p : undefined
      const { t, k, i } = parsed
      if (
        (p === undefined || p === 0 || p === 1) &&
        (k === 'memo' || k === 'repost') &&
        typeof t === 'number' &&
        Number.isFinite(t) &&
        typeof i === 'string' &&
        i.length > 0
      ) {
        return { p: p === 1 ? 1 : 0, t, k, i }
      }
    }
  } catch {
    return null
  }
  return null
}

export async function getPublicMemoDetail(
  username: string,
  memoId: string,
  viewerId: string | null = null,
): Promise<PublicMemoDetail | null> {
  const u = await findUserByUsername(username)
  if (!u) return null
  const memo = await db.query.memos.findFirst({
    where: eq(memos.id, memoId),
  })
  if (!memo || memo.userId !== u.id || memo.deletedAt) return null
  // 非公开/已归档 memo：只有作者本人可见
  const isAuthor = viewerId !== null && viewerId === u.id
  if ((memo.visibility !== 'public' || memo.archived) && !isAuthor) {
    return null
  }
  const [tagRows, counts, viewerState] = await Promise.all([
    loadMemoTags([memo.id]),
    loadMemoCounts([memo.id]).then((m) => m.get(memo.id)),
    loadViewerStates([memo.id], viewerId).then((m) => m.get(memo.id)),
  ])
  return {
    memo: toMemoWithTags(memo, tagRows, counts, viewerState),
    author: {
      id: u.id,
      username: u.username,
      name: u.name,
      image: resolveAvatarUrl(u.image, u.email),
    },
  }
}

/** 公共主页：聚合所有用户的公开 memo（倒序，keyset 分页） */
export async function listAllPublicMemos(
  opts: {
    cursor?: string
    limit?: number
    viewerId?: string | null
    tag?: string
  } = {},
): Promise<{ items: PublicTimelineItem[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 20, 50)
  const conditions = [
    eq(memos.visibility, 'public'),
    eq(memos.archived, false),
    isNull(memos.deletedAt),
  ]
  if (opts.tag) {
    const tagIds = await resolveGlobalTagIds(opts.tag)
    if (tagIds.length === 0) {
      return { items: [], nextCursor: null }
    }
    const memoIds = db
      .select({ memoId: memoTags.memoId })
      .from(memoTags)
      .where(inArray(memoTags.tagId, tagIds))
    conditions.push(inArray(memos.id, memoIds))
  }
  const cur = parseMemoCursor(opts.cursor)
  if (cur) {
    const cond =
      cur.p === 1
        ? eq(memos.globalPinned, false)
        : and(
            eq(memos.globalPinned, false),
            or(
              lt(memos.createdAt, new Date(cur.t)),
              and(eq(memos.createdAt, new Date(cur.t)), lt(memos.id, cur.i)),
            ),
          )
    if (cond) conditions.push(cond)
  }

  const rows = await db
    .select()
    .from(memos)
    .where(and(...conditions))
    .orderBy(desc(memos.globalPinned), desc(memos.createdAt), desc(memos.id))
    .limit(limit + 1)
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)

  const memoIds = page.map((m) => m.id)
  const [tagRows, countsMap, viewerMap, userRows] = await Promise.all([
    loadMemoTags(memoIds),
    loadMemoCounts(memoIds),
    loadViewerStates(memoIds, opts.viewerId ?? null),
    db
      .select({
        id: user.id,
        username: user.username,
        name: user.name,
        image: user.image,
        email: user.email,
      })
      .from(user)
      .where(
        inArray(
          user.id,
          page.map((m) => m.userId),
        ),
      ),
  ])
  const userById = new Map(userRows.map((u) => [u.id, u]))
  const tagByMemo = new Map<string, typeof tagRows>()
  for (const t of tagRows) {
    const list = tagByMemo.get(t.memoId) ?? []
    list.push(t)
    tagByMemo.set(t.memoId, list)
  }

  const items: PublicTimelineItem[] = page.map((m) => {
    const author = userById.get(m.userId)!
    return {
      kind: 'memo' as const,
      memo: toMemoWithTags(
        m,
        tagByMemo.get(m.id) ?? [],
        countsMap.get(m.id),
        viewerMap.get(m.id),
      ),
      author: {
        id: author.id,
        username: author.username,
        name: author.name,
        image: resolveAvatarUrl(author.image, author.email),
      } satisfies MemoAuthor,
      repost: null,
    }
  })
  const last = page[page.length - 1]
  const nextCursor = hasMore
    ? Buffer.from(
        JSON.stringify({
          p: last.globalPinned ? 1 : 0,
          t: last.createdAt.getTime(),
          i: last.id,
        }),
      ).toString('base64url')
    : null
  return { items, nextCursor }
}

function parseMemoCursor(
  cursor?: string,
): { p: 0 | 1; t: number; i: string } | null {
  if (!cursor) return null
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString(),
    )
    if (
      parsed &&
      typeof parsed === 'object' &&
      't' in parsed &&
      'i' in parsed
    ) {
      const p = 'p' in parsed ? parsed.p : undefined
      const { t, i } = parsed
      if (
        (p === undefined || p === 0 || p === 1) &&
        typeof t === 'number' &&
        Number.isFinite(t) &&
        typeof i === 'string' &&
        i.length > 0
      ) {
        return { p: p === 1 ? 1 : 0, t, i }
      }
    }
  } catch {
    return null
  }
  return null
}
