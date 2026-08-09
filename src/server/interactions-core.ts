import { and, asc, count, eq, gt, inArray, or } from 'drizzle-orm'

import { db } from '#/db'
import {
  memoComments,
  memoFavorites,
  memoLikes,
  memoReposts,
  memos,
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
  const map = new Map<string, MemoCounts>()
  if (memoIds.length === 0) return map
  const [likes, favorites, comments, reposts] = await Promise.all([
    db
      .select({ memoId: memoLikes.memoId, total: count() })
      .from(memoLikes)
      .where(inArray(memoLikes.memoId, memoIds))
      .groupBy(memoLikes.memoId),
    db
      .select({ memoId: memoFavorites.memoId, total: count() })
      .from(memoFavorites)
      .where(inArray(memoFavorites.memoId, memoIds))
      .groupBy(memoFavorites.memoId),
    db
      .select({ memoId: memoComments.memoId, total: count() })
      .from(memoComments)
      .where(inArray(memoComments.memoId, memoIds))
      .groupBy(memoComments.memoId),
    db
      .select({ memoId: memoReposts.memoId, total: count() })
      .from(memoReposts)
      .where(inArray(memoReposts.memoId, memoIds))
      .groupBy(memoReposts.memoId),
  ])
  const likeMap = new Map(likes.map((r) => [r.memoId, r.total]))
  const favMap = new Map(favorites.map((r) => [r.memoId, r.total]))
  const commentMap = new Map(comments.map((r) => [r.memoId, r.total]))
  const repostMap = new Map(reposts.map((r) => [r.memoId, r.total]))
  for (const id of memoIds) {
    map.set(id, {
      likes: likeMap.get(id) ?? 0,
      favorites: favMap.get(id) ?? 0,
      comments: commentMap.get(id) ?? 0,
      reposts: repostMap.get(id) ?? 0,
    })
  }
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
  const [likes, favorites, reposts] = await Promise.all([
    db
      .select({ memoId: memoLikes.memoId })
      .from(memoLikes)
      .where(
        and(eq(memoLikes.userId, viewerId), inArray(memoLikes.memoId, memoIds)),
      ),
    db
      .select({ memoId: memoFavorites.memoId })
      .from(memoFavorites)
      .where(
        and(
          eq(memoFavorites.userId, viewerId),
          inArray(memoFavorites.memoId, memoIds),
        ),
      ),
    db
      .select({
        memoId: memoReposts.memoId,
        content: memoReposts.content,
      })
      .from(memoReposts)
      .where(
        and(
          eq(memoReposts.userId, viewerId),
          inArray(memoReposts.memoId, memoIds),
        ),
      ),
  ])
  const likeSet = new Set(likes.map((r) => r.memoId))
  const favSet = new Set(favorites.map((r) => r.memoId))
  const repostSet = new Set(reposts.map((r) => r.memoId))
  for (const id of memoIds) {
    map.set(id, {
      liked: likeSet.has(id),
      favorited: favSet.has(id),
      reposted: repostSet.has(id),
      repostedContent: reposts.find((r) => r.memoId === id)?.content ?? null,
    })
  }
  return map
}

async function assertInteractionAllowed(
  userId: string,
  memoId: string,
): Promise<void> {
  const memo = await db.query.memos.findFirst({
    where: eq(memos.id, memoId),
    columns: { id: true, userId: true, visibility: true },
  })
  if (!memo) throw new Error('memo not found')
  if (memo.visibility !== 'public' && memo.userId !== userId) {
    throw new Error('memo is not public')
  }
}

export async function toggleLikeForUser(
  userId: string,
  memoId: string,
): Promise<{ liked: boolean; counts: MemoCounts }> {
  await assertInteractionAllowed(userId, memoId)
  const existing = await db.query.memoLikes.findFirst({
    where: and(eq(memoLikes.memoId, memoId), eq(memoLikes.userId, userId)),
  })
  if (existing) {
    await db
      .delete(memoLikes)
      .where(and(eq(memoLikes.memoId, memoId), eq(memoLikes.userId, userId)))
  } else {
    await db.insert(memoLikes).values({ memoId, userId, createdAt: new Date() })
  }
  const counts = (await loadMemoCounts([memoId])).get(memoId) ?? EMPTY_COUNTS
  return { liked: !existing, counts }
}

export async function toggleFavoriteForUser(
  userId: string,
  memoId: string,
): Promise<{ favorited: boolean; counts: MemoCounts }> {
  await assertInteractionAllowed(userId, memoId)
  const existing = await db.query.memoFavorites.findFirst({
    where: and(
      eq(memoFavorites.memoId, memoId),
      eq(memoFavorites.userId, userId),
    ),
  })
  if (existing) {
    await db
      .delete(memoFavorites)
      .where(
        and(eq(memoFavorites.memoId, memoId), eq(memoFavorites.userId, userId)),
      )
  } else {
    await db
      .insert(memoFavorites)
      .values({ memoId, userId, createdAt: new Date() })
  }
  const counts = (await loadMemoCounts([memoId])).get(memoId) ?? EMPTY_COUNTS
  return { favorited: !existing, counts }
}

export async function toggleRepostForUser(
  userId: string,
  memoId: string,
  content?: string,
): Promise<{ reposted: boolean; counts: MemoCounts }> {
  await assertInteractionAllowed(userId, memoId)
  const existing = await db.query.memoReposts.findFirst({
    where: and(eq(memoReposts.memoId, memoId), eq(memoReposts.userId, userId)),
  })
  if (existing) {
    await db
      .delete(memoReposts)
      .where(
        and(eq(memoReposts.memoId, memoId), eq(memoReposts.userId, userId)),
      )
  } else {
    await db.insert(memoReposts).values({
      memoId,
      userId,
      content: content?.trim() || null,
      createdAt: new Date(),
    })
  }
  const counts = (await loadMemoCounts([memoId])).get(memoId) ?? EMPTY_COUNTS
  return { reposted: !existing, counts }
}

export async function updateRepostForUser(
  userId: string,
  memoId: string,
  content?: string,
): Promise<{ reposted: boolean; counts: MemoCounts }> {
  await assertInteractionAllowed(userId, memoId)
  const res = await db
    .update(memoReposts)
    .set({ content: content?.trim() || null })
    .where(and(eq(memoReposts.memoId, memoId), eq(memoReposts.userId, userId)))
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
): Promise<CommentItem> {
  await assertInteractionAllowed(userId, memoId)
  const now = new Date()
  const id = ulid()
  await db.insert(memoComments).values({
    id,
    memoId,
    userId,
    content,
    createdAt: now,
    updatedAt: now,
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
      authorEmail: user.email,
    })
    .from(memoComments)
    .innerJoin(user, eq(user.id, memoComments.userId))
    .where(eq(memoComments.id, id))
  if (row.length === 0) throw new Error('comment not found')
  const first = row[0]
  return {
    id: first.id,
    content: first.content,
    createdAt: first.createdAt.toISOString(),
    author: {
      id: first.authorId,
      name: first.authorName,
      username: first.authorUsername,
      image: resolveAvatarUrl(first.authorImage, first.authorEmail),
    },
  }
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
  await db.delete(memoComments).where(eq(memoComments.id, commentId))
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
      authorEmail: user.email,
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
        image: resolveAvatarUrl(r.authorImage, r.authorEmail),
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
    where: eq(memos.id, memoId),
    columns: { userId: true, visibility: true },
  })
  if (!memo) return false
  if (memo.visibility === 'public') return true
  return viewerId !== null && viewerId === memo.userId
}
