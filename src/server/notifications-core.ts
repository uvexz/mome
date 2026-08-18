import { and, count, desc, eq, isNull, lt } from 'drizzle-orm'

import { db } from '#/db'
import { memos, notifications, user } from '#/db/schema'
import { resolveAvatarUrl } from '#/lib/avatar'

export type NotificationType = 'like' | 'comment' | 'repost'

export interface NotificationItem {
  id: string
  type: NotificationType
  referenceId: string
  createdAt: string
  readAt: string | null
  memo: {
    id: string
    content: string
  }
  actor: {
    id: string
    name: string
    username: string
    image: string | null
  }
}

export async function listNotificationsForUser(
  userId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ items: NotificationItem[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 20, 50)
  const conditions = [eq(notifications.userId, userId)]
  if (opts.cursor) conditions.push(lt(notifications.id, opts.cursor))

  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      referenceId: notifications.referenceId,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
      memoId: memos.id,
      memoContent: memos.content,
      actorId: user.id,
      actorName: user.name,
      actorUsername: user.username,
      actorImage: user.image,
    })
    .from(notifications)
    .innerJoin(memos, eq(memos.id, notifications.memoId))
    .innerJoin(user, eq(user.id, notifications.actorId))
    .where(and(...conditions, isNull(memos.deletedAt)))
    .orderBy(desc(notifications.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  return {
    items: page.map((row) => ({
      id: row.id,
      type: row.type,
      referenceId: row.referenceId,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
      memo: { id: row.memoId, content: row.memoContent },
      actor: {
        id: row.actorId,
        name: row.actorName,
        username: row.actorUsername,
        image: resolveAvatarUrl(row.actorImage, row.actorUsername),
      },
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  }
}

export async function countUnreadNotificationsForUser(
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(notifications)
    .innerJoin(memos, eq(memos.id, notifications.memoId))
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        isNull(memos.deletedAt),
      ),
    )
  return row.total
}

export async function markNotificationsReadForUser(
  userId: string,
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
}
