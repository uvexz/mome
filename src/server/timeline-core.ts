import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  like,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import type { SQL, SQLWrapper } from 'drizzle-orm'

import { db } from '#/db'
import {
  memoComments,
  memoFavorites,
  memoLikes,
  memoReposts,
  memos,
  memoTags,
  tags,
  user,
} from '#/db/schema'
import { resolveAvatarUrl } from '#/lib/avatar'
import { tagPathToSegments } from '#/lib/hashtags'
import { escapeLike } from '#/lib/search'

import { loadMemoCounts, loadViewerStates } from './interactions-core'
import {
  listMemosForUser,
  loadMemoTags,
  resolveTagIds,
  toMemoWithTags,
} from './memos-core'
import type { MemoWithTags } from './memos-core'

/** memo 原作者（公开页 / 转发 / 互动列表共用） */
export interface MemoAuthor {
  id: string
  username: string
  name: string
  image: string | null
}

/** 转发上下文：附言 + 转发时间 + 转发者 */
export interface RepostContext {
  content: string | null
  createdAt: string
  reposter: MemoAuthor
}

/** 统一时间线条目：自己的 memo 或转发的他人 memo */
export interface TimelineItem {
  kind: 'memo' | 'repost'
  memo: MemoWithTags
  /** 原作者；自己的 memo 为 null（无作者头，可操作） */
  author: MemoAuthor | null
  repost: RepostContext | null
}

export type InteractionKind = 'likes' | 'favorites' | 'comments' | 'reposts'

/** 互动页条目：互动对象 memo + 原作者 + 互动时间/内容 */
export interface InteractionItem {
  kind: InteractionKind
  memo: MemoWithTags
  author: MemoAuthor
  content: string | null
  interactedAt: string
}

/** 按 memoId 批量加载原作者（memos.userId → user） */
export async function loadMemoAuthors(
  memoIds: string[],
): Promise<Map<string, MemoAuthor>> {
  const map = new Map<string, MemoAuthor>()
  if (memoIds.length === 0) return map
  const rows = await db
    .select({
      memoId: memos.id,
      id: user.id,
      username: user.username,
      name: user.name,
      image: user.image,
      email: user.email,
    })
    .from(memos)
    .innerJoin(user, eq(user.id, memos.userId))
    .where(inArray(memos.id, memoIds))
  for (const r of rows) {
    map.set(r.memoId, {
      id: r.id,
      username: r.username,
      name: r.name,
      image: resolveAvatarUrl(r.image, r.email),
    })
  }
  return map
}

/**
 * 跨用户解析标签路径：找到所有用户名下匹配该路径的标签，
 * 并包含其全部后代（用于转发 memo 的标签筛选）。
 */
export async function resolveGlobalTagIds(tagPath: string): Promise<string[]> {
  const segments = tagPathToSegments(tagPath)
  if (segments.length === 0) return []

  let ids = (
    await db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.name, segments[0]), isNull(tags.parentId)))
  ).map((r) => r.id)

  for (let i = 1; i < segments.length; i++) {
    if (ids.length === 0) return []
    ids = (
      await db
        .select({ id: tags.id })
        .from(tags)
        .where(and(inArray(tags.parentId, ids), eq(tags.name, segments[i])))
    ).map((r) => r.id)
  }
  if (ids.length === 0) return []

  // 收集全部后代
  const result = new Set(ids)
  const queue = [...ids]
  while (queue.length > 0) {
    const children = await db
      .select({ id: tags.id })
      .from(tags)
      .where(inArray(tags.parentId, queue))
    queue.length = 0
    for (const child of children) {
      if (!result.has(child.id)) {
        result.add(child.id)
        queue.push(child.id)
      }
    }
  }
  return [...result]
}

// ── 个人时间线（自己的 memo + 转发的他人 memo） ─────────
export interface HomeFeedParams {
  cursor?: string
  limit?: number
  tag?: string
  q?: string
  filter?: 'all' | 'archived'
}

type HomeCursor = { p: 0 | 1; k?: 'memo' | 'repost'; t: number; i: string }

/**
 * 个人时间线：自己的 memo（置顶优先）+ 转发的其他用户公开 memo。
 * 归档视图仅返回自己的归档 memo。
 */
export async function listHomeFeedForUser(
  userId: string,
  params: HomeFeedParams = {},
  viewerId: string | null = userId,
): Promise<{ items: TimelineItem[]; nextCursor: string | null }> {
  const limit = Math.min(params.limit ?? 20, 50)

  if (params.filter === 'archived') {
    const res = await listMemosForUser(
      userId,
      {
        cursor: params.cursor,
        limit,
        tag: params.tag,
        q: params.q,
        filter: 'archived',
      },
      viewerId,
    )
    return {
      items: res.items.map((memo) => ({
        kind: 'memo' as const,
        memo,
        author: null,
        repost: null,
      })),
      nextCursor: res.nextCursor,
    }
  }

  const cur = parseHomeCursor(params.cursor)
  const pinned: TimelineItem[] = []

  // 置顶区：游标位于置顶区时继续向后取；取完才进入普通区
  if (!cur || cur.p === 1) {
    const pinRows = await fetchPinnedMemoRows(userId, {
      limit: limit + 1,
      tag: params.tag,
      q: params.q,
      cursor: cur && cur.p === 1 ? { t: cur.t, i: cur.i } : undefined,
    })
    if (pinRows.length > limit) {
      const last = pinRows[limit - 1]
      return {
        items: pinRows.slice(0, limit).map((memo): TimelineItem => ({
          kind: 'memo' as const,
          memo: toMemoWithTags(memo, []),
          author: null,
          repost: null,
        })),
        nextCursor: makeCursor({
          p: 1,
          t: last.createdAt.getTime(),
          i: last.id,
        }),
      }
    }
    pinned.push(
      ...pinRows.map((memo): TimelineItem => ({
        kind: 'memo' as const,
        memo: toMemoWithTags(memo, []),
        author: null,
        repost: null,
      })),
    )
  }

  const remaining = limit - pinned.length
  const merged = await fetchMergedTimeline(userId, {
    limit: remaining + 1,
    tag: params.tag,
    q: params.q,
    cursor: cur && cur.p === 0 ? cur : undefined,
    viewerId,
  })
  const page = [...pinned, ...merged.items.slice(0, remaining)]
  const hasMore = merged.items.length > remaining
  let nextCursor: string | null = null
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1]
    nextCursor =
      last.kind === 'memo' && last.memo.pinned
        ? makeCursor({
            p: 1,
            t: new Date(last.memo.createdAt).getTime(),
            i: last.memo.id,
          })
        : makeCursor({ p: 0, k: last.kind, t: itemTime(last), i: last.memo.id })
  }
  return { items: page, nextCursor }
}

function itemTime(item: TimelineItem): number {
  return item.kind === 'repost' && item.repost
    ? new Date(item.repost.createdAt).getTime()
    : new Date(item.memo.createdAt).getTime()
}

async function fetchPinnedMemoRows(
  userId: string,
  opts: {
    limit: number
    tag?: string
    q?: string
    cursor?: { t: number; i: string }
  },
): Promise<Array<typeof memos.$inferSelect>> {
  const conditions = [
    eq(memos.userId, userId),
    eq(memos.pinned, true),
    eq(memos.archived, false),
  ]
  if (opts.q) {
    conditions.push(
      like(memos.content, sql`${`%${escapeLike(opts.q)}%`} ESCAPE '\\'`),
    )
  }
  if (opts.tag) {
    const tagIds = await resolveTagIds(userId, opts.tag)
    if (tagIds.length === 0) return []
    const memoIds = db
      .select({ memoId: memoTags.memoId })
      .from(memoTags)
      .where(inArray(memoTags.tagId, tagIds))
    conditions.push(inArray(memos.id, memoIds))
  }
  if (opts.cursor) {
    const cond = or(
      lt(memos.createdAt, new Date(opts.cursor.t)),
      and(
        eq(memos.createdAt, new Date(opts.cursor.t)),
        lt(memos.id, opts.cursor.i),
      ),
    )
    if (cond) conditions.push(cond)
  }
  return db
    .select()
    .from(memos)
    .where(and(...conditions))
    .orderBy(desc(memos.createdAt), desc(memos.id))
    .limit(opts.limit)
}

async function fetchMergedTimeline(
  userId: string,
  opts: {
    limit: number
    tag?: string
    q?: string
    cursor?: HomeCursor
    viewerId?: string | null
  },
): Promise<{ items: TimelineItem[] }> {
  const conditions = [
    eq(memos.userId, userId),
    eq(memos.pinned, false),
    eq(memos.archived, false),
  ]
  const repostConditions = [
    eq(memoReposts.userId, userId),
    ne(memos.userId, userId),
    eq(memos.visibility, 'public'),
    eq(memos.archived, false),
  ]
  if (opts.q) {
    const pattern = sql`${`%${escapeLike(opts.q)}%`} ESCAPE '\\'`
    conditions.push(like(memos.content, pattern))
    const repostHit = or(
      like(memos.content, pattern),
      like(memoReposts.content, pattern),
    )
    if (repostHit) repostConditions.push(repostHit)
  }
  if (opts.tag) {
    const ownTagIds = await resolveTagIds(userId, opts.tag)
    if (ownTagIds.length === 0) {
      conditions.push(eq(memos.id, ''))
    } else {
      const memoIds = db
        .select({ memoId: memoTags.memoId })
        .from(memoTags)
        .where(inArray(memoTags.tagId, ownTagIds))
      conditions.push(inArray(memos.id, memoIds))
    }
    const globalTagIds = await resolveGlobalTagIds(opts.tag)
    if (globalTagIds.length === 0) {
      repostConditions.push(eq(memos.id, ''))
    } else {
      const memoIds = db
        .select({ memoId: memoTags.memoId })
        .from(memoTags)
        .where(inArray(memoTags.tagId, globalTagIds))
      repostConditions.push(inArray(memos.id, memoIds))
    }
  }

  const cur = opts.cursor
  if (cur) {
    if (cur.k !== 'repost') {
      const cond = or(
        lt(memos.createdAt, new Date(cur.t)),
        and(eq(memos.createdAt, new Date(cur.t)), lt(memos.id, cur.i)),
      )
      if (cond) conditions.push(cond)
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

  const [memoRows, repostRows] = await Promise.all([
    db
      .select()
      .from(memos)
      .where(and(...conditions))
      .orderBy(desc(memos.createdAt), desc(memos.id))
      .limit(opts.limit + 1),
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
      .orderBy(desc(memoReposts.createdAt), desc(memoReposts.memoId))
      .limit(opts.limit + 1),
  ])

  type Candidate = {
    t: number
    k: 'memo' | 'repost'
    i: string
    memoRow: typeof memos.$inferSelect
    repostRow: (typeof repostRows)[number] | null
  }
  const candidates: Candidate[] = [
    ...memoRows.map((m) => ({
      t: m.createdAt.getTime(),
      k: 'memo' as const,
      i: m.id,
      memoRow: m,
      repostRow: null,
    })),
    ...repostRows.map((r) => ({
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
  const page = candidates.slice(0, opts.limit)

  const memoIds = page.map((c) => c.memoRow.id)
  const [tagRows, countsMap, viewerMap, authorMap, me] = await Promise.all([
    loadMemoTags(memoIds),
    loadMemoCounts(memoIds),
    loadViewerStates(memoIds, opts.viewerId ?? null),
    loadMemoAuthors(memoIds),
    db.query.user.findFirst({
      where: eq(user.id, userId),
      columns: {
        id: true,
        username: true,
        name: true,
        image: true,
        email: true,
      },
    }),
  ])
  const tagByMemo = new Map<string, typeof tagRows>()
  for (const t of tagRows) {
    const list = tagByMemo.get(t.memoId) ?? []
    list.push(t)
    tagByMemo.set(t.memoId, list)
  }
  const reposter: MemoAuthor = me
    ? {
        id: me.id,
        username: me.username,
        name: me.name,
        image: resolveAvatarUrl(me.image, me.email),
      }
    : { id: userId, username: 'me', name: '我', image: null }

  const items: TimelineItem[] = page.map((c) => ({
    kind: c.k,
    memo: toMemoWithTags(
      c.memoRow,
      tagByMemo.get(c.memoRow.id) ?? [],
      countsMap.get(c.memoRow.id),
      viewerMap.get(c.memoRow.id),
    ),
    author: c.k === 'memo' ? null : (authorMap.get(c.memoRow.id) ?? null),
    repost: c.repostRow
      ? {
          content: c.repostRow.content,
          createdAt: c.repostRow.createdAt.toISOString(),
          reposter,
        }
      : null,
  }))
  return { items }
}

function parseHomeCursor(cursor?: string): HomeCursor | null {
  if (!cursor) return null
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString(),
    )
    if (
      parsed &&
      typeof parsed === 'object' &&
      'p' in parsed &&
      't' in parsed &&
      'i' in parsed
    ) {
      const { p, k, t, i } = parsed as {
        p?: unknown
        k?: unknown
        t?: unknown
        i?: unknown
      }
      if (
        (p === 0 || p === 1) &&
        typeof t === 'number' &&
        Number.isFinite(t) &&
        typeof i === 'string' &&
        i.length > 0 &&
        (k === undefined || k === 'memo' || k === 'repost')
      ) {
        return { p, k, t, i }
      }
    }
  } catch {
    return null
  }
  return null
}

// ── 互动页：点赞 / 收藏 / 回复 / 转发 ────────────────────
export async function listInteractionsForUser(
  userId: string,
  kind: InteractionKind,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ items: InteractionItem[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 20, 50)
  const cur = parseInteractionCursor(opts.cursor)
  // 不泄露已转私有的 memo：只列出公开的或本人的
  const visibleMemoCond = or(
    eq(memos.visibility, 'public'),
    eq(memos.userId, userId),
  )

  let rows: Array<{
    memo: typeof memos.$inferSelect
    interactedAt: Date
    keyId: string
    content: string | null
  }> = []

  if (kind === 'likes') {
    const res = await db
      .select({
        memo: memos,
        interactedAt: memoLikes.createdAt,
        keyId: memoLikes.memoId,
      })
      .from(memoLikes)
      .innerJoin(memos, eq(memos.id, memoLikes.memoId))
      .where(
        and(
          eq(memoLikes.userId, userId),
          visibleMemoCond,
          keysetCondition(memoLikes.createdAt, memoLikes.memoId, cur),
        ),
      )
      .orderBy(desc(memoLikes.createdAt), desc(memoLikes.memoId))
      .limit(limit + 1)
    rows = res.map((r) => ({
      memo: r.memo,
      interactedAt: r.interactedAt,
      keyId: r.keyId,
      content: null,
    }))
  } else if (kind === 'favorites') {
    const res = await db
      .select({
        memo: memos,
        interactedAt: memoFavorites.createdAt,
        keyId: memoFavorites.memoId,
      })
      .from(memoFavorites)
      .innerJoin(memos, eq(memos.id, memoFavorites.memoId))
      .where(
        and(
          eq(memoFavorites.userId, userId),
          visibleMemoCond,
          keysetCondition(memoFavorites.createdAt, memoFavorites.memoId, cur),
        ),
      )
      .orderBy(desc(memoFavorites.createdAt), desc(memoFavorites.memoId))
      .limit(limit + 1)
    rows = res.map((r) => ({
      memo: r.memo,
      interactedAt: r.interactedAt,
      keyId: r.keyId,
      content: null,
    }))
  } else if (kind === 'comments') {
    const res = await db
      .select({
        memo: memos,
        interactedAt: memoComments.createdAt,
        keyId: memoComments.id,
        content: memoComments.content,
      })
      .from(memoComments)
      .innerJoin(memos, eq(memos.id, memoComments.memoId))
      .where(
        and(
          eq(memoComments.userId, userId),
          visibleMemoCond,
          keysetCondition(memoComments.createdAt, memoComments.id, cur),
        ),
      )
      .orderBy(desc(memoComments.createdAt), desc(memoComments.id))
      .limit(limit + 1)
    rows = res.map((r) => ({
      memo: r.memo,
      interactedAt: r.interactedAt,
      keyId: r.keyId,
      content: r.content,
    }))
  } else {
    const res = await db
      .select({
        memo: memos,
        interactedAt: memoReposts.createdAt,
        keyId: memoReposts.memoId,
        content: memoReposts.content,
      })
      .from(memoReposts)
      .innerJoin(memos, eq(memos.id, memoReposts.memoId))
      .where(
        and(
          eq(memoReposts.userId, userId),
          visibleMemoCond,
          keysetCondition(memoReposts.createdAt, memoReposts.memoId, cur),
        ),
      )
      .orderBy(desc(memoReposts.createdAt), desc(memoReposts.memoId))
      .limit(limit + 1)
    rows = res.map((r) => ({
      memo: r.memo,
      interactedAt: r.interactedAt,
      keyId: r.keyId,
      content: r.content,
    }))
  }

  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const memoIds = page.map((r) => r.memo.id)
  const [tagRows, countsMap, viewerMap, authorMap] = await Promise.all([
    loadMemoTags(memoIds),
    loadMemoCounts(memoIds),
    loadViewerStates(memoIds, userId),
    loadMemoAuthors(memoIds),
  ])
  const tagByMemo = new Map<string, typeof tagRows>()
  for (const t of tagRows) {
    const list = tagByMemo.get(t.memoId) ?? []
    list.push(t)
    tagByMemo.set(t.memoId, list)
  }

  const items: InteractionItem[] = page.map((r) => ({
    kind,
    memo: toMemoWithTags(
      r.memo,
      tagByMemo.get(r.memo.id) ?? [],
      countsMap.get(r.memo.id),
      viewerMap.get(r.memo.id),
    ),
    author: authorMap.get(r.memo.id) ?? {
      id: r.memo.userId,
      username: 'unknown',
      name: '未知用户',
      image: null,
    },
    content: r.content,
    interactedAt: r.interactedAt.toISOString(),
  }))

  let nextCursor: string | null = null
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1]
    nextCursor = makeCursor({ t: last.interactedAt.getTime(), i: last.keyId })
  }
  return { items, nextCursor }
}

function keysetCondition(
  createdAt: SQLWrapper,
  id: SQLWrapper,
  cur: { t: number; i: string } | null,
): SQL | undefined {
  if (!cur) return undefined
  return or(
    lt(createdAt, new Date(cur.t)),
    and(eq(createdAt, new Date(cur.t)), lt(id, cur.i)),
  )
}

function parseInteractionCursor(
  cursor?: string,
): { t: number; i: string } | null {
  const parsed = parseCursorJson<{ t?: unknown; i?: unknown }>(cursor)
  if (
    parsed &&
    typeof parsed.t === 'number' &&
    Number.isFinite(parsed.t) &&
    typeof parsed.i === 'string' &&
    parsed.i.length > 0
  ) {
    return { t: parsed.t, i: parsed.i }
  }
  return null
}

function parseCursorJson<T>(cursor?: string): T | null {
  if (!cursor) return null
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString()) as T
  } catch {
    return null
  }
}

function makeCursor(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}
