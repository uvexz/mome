import { and, asc, count, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'

import { db } from '#/db'
import {
  memoComments,
  memoFavorites,
  memoLikes,
  memoReposts,
  memos,
  notifications,
  user,
} from '#/db/schema'
import { resolveAvatarUrl } from '#/lib/avatar'
import { ulid } from '#/lib/ulid'

export interface MemoCounts {
  likes: number
  favorites: number
  comments: number
  reposts: number
}

export interface ViewerState {
  liked: boolean
  favorited: boolean
  reposted: boolean
  repostedContent: string | null
}

export interface CommentItem {
  id: string
  content: string
  createdAt: string
  author: {
    id: string
    name: string
    username: string
    image: string | null
  }
}

export const EMPTY_COUNTS: MemoCounts = {
  likes: 0,
  favorites: 0,
  comments: 0,
  reposts: 0,
}

export const EMPTY_VIEWER_STATE: ViewerState = {
  liked: false,
  favorited: false,
  reposted: false,
  repostedContent: null,
}

export async function loadMemoCounts(
  memoIds: string[],
): Promise<Map<string, MemoCounts>> {
  const map = new Map<string, MemoCounts>(
    memoIds.map((memoId) => [memoId, { ...EMPTY_COUNTS }]),
  )
  if (memoIds.length === 0) return map
  const [likeRows, favoriteRows, commentRows, repostRows] = await Promise.all([
    db
      .select({ memoId: memoLikes.memoId, value: count() })
      .from(memoLikes)
      .where(inArray(memoLikes.memoId, memoIds))
      .groupBy(memoLikes.memoId),
    db
      .select({ memoId: memoFavorites.memoId, value: count() })
      .from(memoFavorites)
      .where(inArray(memoFavorites.memoId, memoIds))
      .groupBy(memoFavorites.memoId),
    db
      .select({ memoId: memoComments.memoId, value: count() })
      .from(memoComments)
      .where(inArray(memoComments.memoId, memoIds))
      .groupBy(memoComments.memoId),
    db
      .select({ memoId: memoReposts.memoId, value: count() })
      .from(memoReposts)
      .where(inArray(memoReposts.memoId, memoIds))
      .groupBy(memoReposts.memoId),
  ])
  for (const row of likeRows) map.get(row.memoId)!.likes = Number(row.value)
  for (const row of favoriteRows)
    map.get(row.memoId)!.favorites = Number(row.value)
  for (const row of commentRows)
    map.get(row.memoId)!.comments = Number(row.value)
  for (const row of repostRows) map.get(row.memoId)!.reposts = Number(row.value)
  return map
}

export async function loadViewerStates(
  memoIds: string[],
  viewerId: string | null,
): Promise<Map<string, ViewerState>> {
  const map = new Map<string, ViewerState>()
  if (!viewerId || memoIds.length === 0) {
    for (const id of memoIds) map.set(id, { ...EMPTY_VIEWER_STATE })
    return map
  }
  const rows = await db
    .select({
      memoId: memos.id,
      liked: sql<number>`EXISTS(SELECT 1 FROM ${memoLikes} WHERE ${memoLikes.memoId} = ${memos.id} AND ${memoLikes.userId} = ${viewerId})`,
      favorited: sql<number>`EXISTS(SELECT 1 FROM ${memoFavorites} WHERE ${memoFavorites.memoId} = ${memos.id} AND ${memoFavorites.userId} = ${viewerId})`,
      reposted: sql<number>`EXISTS(SELECT 1 FROM ${memoReposts} WHERE ${memoReposts.memoId} = ${memos.id} AND ${memoReposts.userId} = ${viewerId})`,
      repostedContent: sql<
        string | null
      >`(SELECT ${memoReposts.content} FROM ${memoReposts} WHERE ${memoReposts.memoId} = ${memos.id} AND ${memoReposts.userId} = ${viewerId} LIMIT 1)`,
    })
    .from(memos)
    .where(inArray(memos.id, memoIds))
  for (const row of rows) {
    map.set(row.memoId, {
      liked: Boolean(row.liked),
      favorited: Boolean(row.favorited),
      reposted: Boolean(row.reposted),
      repostedContent: row.repostedContent,
    })
  }
  return map
}

/** 事务内为互动写入通知（对方 memo 才通知，重复事件幂等） */
async function insertNotificationInTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  actorId: string,
  memoId: string,
  type: 'like' | 'comment' | 'repost',
  referenceId = '',
): Promise<void> {
  const memo = await tx.query.memos.findFirst({
    where: and(eq(memos.id, memoId), isNull(memos.deletedAt)),
    columns: { userId: true },
  })
  if (!memo || memo.userId === actorId) return
  await tx
    .insert(notifications)
    .values({
      id: ulid(),
      userId: memo.userId,
      actorId,
      memoId,
      type,
      referenceId,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
}

async function deleteNotificationInTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  actorId: string,
  memoId: string,
  type: 'like' | 'comment' | 'repost',
  referenceId = '',
): Promise<void> {
  await tx
    .delete(notifications)
    .where(
      and(
        eq(notifications.actorId, actorId),
        eq(notifications.memoId, memoId),
        eq(notifications.type, type),
        eq(notifications.referenceId, referenceId),
      ),
    )
}

export async function toggleLikeForUser(
  userId: string,
  memoId: string,
): Promise<{ liked: boolean; counts: MemoCounts }> {
  // 查重 + 写入 + 通知在同一事务内，并发双击只会得到确定性的 toggle 序列，
  // 不会因主键冲突抛 500，也不会出现"互动成功但通知失败"的不一致
  const liked = await db.transaction(async (tx) => {
    const existing = await tx.query.memoLikes.findFirst({
      where: and(eq(memoLikes.memoId, memoId), eq(memoLikes.userId, userId)),
    })
    if (existing) {
      await tx
        .delete(memoLikes)
        .where(and(eq(memoLikes.memoId, memoId), eq(memoLikes.userId, userId)))
      await deleteNotificationInTx(tx, userId, memoId, 'like')
      return false
    }
    const inserted = await tx.all(sql`
      INSERT INTO ${memoLikes} (memo_id, user_id, created_at)
      SELECT ${memos.id}, ${userId}, ${Date.now()}
      FROM ${memos}
      WHERE ${memos.id} = ${memoId}
        AND ${memos.deletedAt} IS NULL
        AND (${memos.visibility} = 'public' OR ${memos.userId} = ${userId})
      RETURNING memo_id
    `)
    if (inserted.length !== 1) throw new Error('memo not found or not public')
    await insertNotificationInTx(tx, userId, memoId, 'like')
    return true
  })
  const counts = (await loadMemoCounts([memoId])).get(memoId) ?? EMPTY_COUNTS
  return { liked, counts }
}

export async function toggleFavoriteForUser(
  userId: string,
  memoId: string,
): Promise<{ favorited: boolean; counts: MemoCounts }> {
  const favorited = await db.transaction(async (tx) => {
    const existing = await tx.query.memoFavorites.findFirst({
      where: and(
        eq(memoFavorites.memoId, memoId),
        eq(memoFavorites.userId, userId),
      ),
    })
    if (existing) {
      await tx
        .delete(memoFavorites)
        .where(
          and(
            eq(memoFavorites.memoId, memoId),
            eq(memoFavorites.userId, userId),
          ),
        )
      return false
    }
    const inserted = await tx.all(sql`
      INSERT INTO ${memoFavorites} (memo_id, user_id, created_at)
      SELECT ${memos.id}, ${userId}, ${Date.now()}
      FROM ${memos}
      WHERE ${memos.id} = ${memoId}
        AND ${memos.deletedAt} IS NULL
        AND (${memos.visibility} = 'public' OR ${memos.userId} = ${userId})
      RETURNING memo_id
    `)
    if (inserted.length !== 1) throw new Error('memo not found or not public')
    return true
  })
  const counts = (await loadMemoCounts([memoId])).get(memoId) ?? EMPTY_COUNTS
  return { favorited, counts }
}

export async function toggleRepostForUser(
  userId: string,
  memoId: string,
  content?: string,
): Promise<{ reposted: boolean; counts: MemoCounts }> {
  const reposted = await db.transaction(async (tx) => {
    const existing = await tx.query.memoReposts.findFirst({
      where: and(
        eq(memoReposts.memoId, memoId),
        eq(memoReposts.userId, userId),
      ),
    })
    if (existing) {
      await tx
        .delete(memoReposts)
        .where(
          and(eq(memoReposts.memoId, memoId), eq(memoReposts.userId, userId)),
        )
      await deleteNotificationInTx(tx, userId, memoId, 'repost')
      return false
    }
    const inserted = await tx.all(sql`
      INSERT INTO ${memoReposts} (memo_id, user_id, content, created_at)
      SELECT ${memos.id}, ${userId}, ${content?.trim() || null}, ${Date.now()}
      FROM ${memos}
      WHERE ${memos.id} = ${memoId}
        AND ${memos.deletedAt} IS NULL
        AND (${memos.visibility} = 'public' OR ${memos.userId} = ${userId})
      RETURNING memo_id
    `)
    if (inserted.length !== 1) throw new Error('memo not found or not public')
    await insertNotificationInTx(tx, userId, memoId, 'repost')
    return true
  })
  const counts = (await loadMemoCounts([memoId])).get(memoId) ?? EMPTY_COUNTS
  return { reposted, counts }
}

export async function updateRepostForUser(
  userId: string,
  memoId: string,
  content?: string,
): Promise<{ reposted: boolean; counts: MemoCounts }> {
  const res = await db
    .update(memoReposts)
    .set({ content: content?.trim() || null })
    .where(
      and(
        eq(memoReposts.memoId, memoId),
        eq(memoReposts.userId, userId),
        sql`EXISTS (
          SELECT 1 FROM ${memos}
          WHERE ${memos.id} = ${memoId}
            AND ${memos.deletedAt} IS NULL
            AND (${memos.visibility} = 'public' OR ${memos.userId} = ${userId})
        )`,
      ),
    )
    .returning()
  if (res.length === 0) {
    throw new Error('repost not found')
  }
  const counts = (await loadMemoCounts([memoId])).get(memoId) ?? EMPTY_COUNTS
  return { reposted: true, counts }
}

export async function addCommentForUser(
  userId: string,
  memoId: string,
  content: string,
): Promise<{ comment: CommentItem; counts: MemoCounts }> {
  const now = new Date()
  const id = ulid()
  // 评论与通知写入同一事务，避免"评论成功但通知丢失"的不一致
  await db.transaction(async (tx) => {
    const inserted = await tx.all(sql`
      INSERT INTO ${memoComments}
        (id, memo_id, user_id, content, created_at, updated_at)
      SELECT ${id}, ${memos.id}, ${userId}, ${content}, ${now.getTime()}, ${now.getTime()}
      FROM ${memos}
      WHERE ${memos.id} = ${memoId}
        AND ${memos.deletedAt} IS NULL
        AND (${memos.visibility} = 'public' OR ${memos.userId} = ${userId})
      RETURNING id
    `)
    if (inserted.length !== 1) throw new Error('memo not found or not public')
    await insertNotificationInTx(tx, userId, memoId, 'comment', id)
  })
  const row = await db
    .select({
      id: memoComments.id,
      content: memoComments.content,
      createdAt: memoComments.createdAt,
      authorId: user.id,
      authorName: user.name,
      authorUsername: user.username,
      authorImage: user.image,
    })
    .from(memoComments)
    .innerJoin(user, eq(user.id, memoComments.userId))
    .where(eq(memoComments.id, id))
  if (row.length === 0) throw new Error('comment not found')
  const first = row[0]
  const comment: CommentItem = {
    id: first.id,
    content: first.content,
    createdAt: first.createdAt.toISOString(),
    author: {
      id: first.authorId,
      name: first.authorName,
      username: first.authorUsername,
      image: resolveAvatarUrl(first.authorImage, first.authorUsername),
    },
  }
  const counts = (await loadMemoCounts([memoId])).get(memoId) ?? EMPTY_COUNTS
  return { comment, counts }
}

export async function deleteCommentForUser(
  userId: string,
  commentId: string,
): Promise<{ deleted: boolean; counts: MemoCounts }> {
  const comment = await db.query.memoComments.findFirst({
    where: eq(memoComments.id, commentId),
  })
  if (!comment || comment.userId !== userId) {
    return { deleted: false, counts: EMPTY_COUNTS }
  }
  await db.transaction(async (tx) => {
    await tx.delete(memoComments).where(eq(memoComments.id, commentId))
    await deleteNotificationInTx(
      tx,
      userId,
      comment.memoId,
      'comment',
      commentId,
    )
  })
  const counts =
    (await loadMemoCounts([comment.memoId])).get(comment.memoId) ?? EMPTY_COUNTS
  return { deleted: true, counts }
}

export async function listCommentsForMemo(
  memoId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ items: CommentItem[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 20, 50)
  const conditions = [eq(memoComments.memoId, memoId)]
  if (opts.cursor) {
    const cur = await db.query.memoComments.findFirst({
      where: eq(memoComments.id, opts.cursor),
      columns: { createdAt: true, id: true },
    })
    if (cur) {
      const cond = or(
        gt(memoComments.createdAt, cur.createdAt),
        and(
          eq(memoComments.createdAt, cur.createdAt),
          gt(memoComments.id, cur.id),
        ),
      )
      if (cond) conditions.push(cond)
    }
  }
  const rows = await db
    .select({
      id: memoComments.id,
      content: memoComments.content,
      createdAt: memoComments.createdAt,
      authorId: user.id,
      authorName: user.name,
      authorUsername: user.username,
      authorImage: user.image,
    })
    .from(memoComments)
    .innerJoin(user, eq(user.id, memoComments.userId))
    .where(and(...conditions))
    .orderBy(asc(memoComments.createdAt), asc(memoComments.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  return {
    items: page.map((r) => ({
      id: r.id,
      content: r.content,
      createdAt: r.createdAt.toISOString(),
      author: {
        id: r.authorId,
        name: r.authorName,
        username: r.authorUsername,
        image: resolveAvatarUrl(r.authorImage, r.authorUsername),
      },
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  }
}

/** 查询单条 memo 是否存在且对 viewer 可见（私有 memo 仅作者可见） */
export async function assertMemoVisibleToUser(
  memoId: string,
  viewerId: string | null,
): Promise<boolean> {
  const memo = await db.query.memos.findFirst({
    where: and(eq(memos.id, memoId), isNull(memos.deletedAt)),
    columns: { userId: true, visibility: true },
  })
  if (!memo) return false
  if (memo.visibility === 'public') return true
  return viewerId !== null && viewerId === memo.userId
}
