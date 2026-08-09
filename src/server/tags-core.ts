import { and, count, desc, eq, isNull } from 'drizzle-orm'

import { db } from '#/db'
import { memos, memoTags, tags } from '#/db/schema'

export interface TagWithCount {
  id: string
  name: string
  parentId: string | null
  count: number
}

/**
 * 标签列表（含使用频次），按 count 倒序；只统计未归档 memo。
 */
export async function listTagsForUser(userId: string): Promise<TagWithCount[]> {
  const counts = await db
    .select({ tagId: memoTags.tagId, count: count() })
    .from(memoTags)
    .innerJoin(memos, eq(memos.id, memoTags.memoId))
    .where(
      and(
        eq(memos.userId, userId),
        eq(memos.archived, false),
        isNull(memos.deletedAt),
      ),
    )
    .groupBy(memoTags.tagId)
    .orderBy(desc(count()))

  const tagRows = await db.query.tags.findMany({
    where: eq(tags.userId, userId),
  })
  const tagById = new Map(tagRows.map((t) => [t.id, t]))

  // 只统计被使用到的标签，但父标签即使 count=0 也要带上（保证层级路径完整）
  const included = new Set<string>(counts.map((c) => c.tagId))
  for (const c of counts) {
    let parentId = tagById.get(c.tagId)?.parentId ?? null
    while (parentId && !included.has(parentId)) {
      included.add(parentId)
      parentId = tagById.get(parentId)?.parentId ?? null
    }
  }

  // 计数向所有祖先累加（支持任意深度）
  const totalByTag = new Map<string, number>()
  for (const c of counts) {
    const tag = tagById.get(c.tagId)
    let current: string | null = tag?.id ?? null
    while (current) {
      totalByTag.set(current, (totalByTag.get(current) ?? 0) + c.count)
      current = tagById.get(current)?.parentId ?? null
    }
  }

  return tagRows
    .filter((t) => included.has(t.id))
    .map<TagWithCount>((t) => ({
      id: t.id,
      name: t.name,
      parentId: t.parentId,
      count: totalByTag.get(t.id) ?? 0,
    }))
    .sort((a, b) => b.count - a.count)
}
