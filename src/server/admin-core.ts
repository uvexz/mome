import { and, eq, sql } from 'drizzle-orm'

import { db } from '#/db'
import { adminUsers, user } from '#/db/schema'

export async function claimFirstAdminForUser(userId: string): Promise<boolean> {
  const claimed = await db
    .insert(adminUsers)
    .select(
      db
        .select({
          userId: user.id,
          createdAt: sql<Date>`${new Date()}`.as('created_at'),
        })
        .from(user)
        .where(
          and(
            eq(user.id, userId),
            sql`NOT EXISTS (SELECT 1 FROM ${adminUsers} LIMIT 1)`,
          ),
        ),
    )
    .onConflictDoNothing()
    .returning({ userId: adminUsers.userId })
  return claimed.length === 1
}

export async function removeAdminForUser(userId: string): Promise<boolean> {
  const removed = await db
    .delete(adminUsers)
    .where(
      and(
        eq(adminUsers.userId, userId),
        sql`EXISTS (SELECT 1 FROM ${adminUsers} AS other WHERE other.user_id <> ${userId})`,
      ),
    )
    .returning({ userId: adminUsers.userId })
  if (removed.length > 0) return true
  const stillAdmin = await db.query.adminUsers.findFirst({
    where: eq(adminUsers.userId, userId),
    columns: { userId: true },
  })
  if (stillAdmin) throw new Error('至少保留一名管理员')
  return false
}
