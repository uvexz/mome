import { useEffect, useMemo, useRef } from 'react'
import { Button, Loader } from '@cloudflare/kumo'
import { Funnel } from '@phosphor-icons/react'

import type { MemoWithTags } from '#/server/memos'
import type { TimelineItem } from '#/server/timeline-core'
import { dayLabel } from '#/lib/date'
import { MemoCard } from './memo-card'

interface MemoFeedProps {
  items: TimelineItem[]
  hasMore: boolean
  loading: boolean
  onLoadMore: () => void
  onTogglePin: (memo: MemoWithTags) => void
  onEdit: (memo: MemoWithTags) => void
  onReference: (memo: MemoWithTags) => void
  onToggleArchive: (memo: MemoWithTags) => void
  onDelete: (memo: MemoWithTags) => void
  deleted?: boolean
  onRestore?: (memo: MemoWithTags) => void
  onPurge?: (memo: MemoWithTags) => void
  onToggleVisibility: (memo: MemoWithTags) => void
  onLike: (memo: MemoWithTags) => void
  onFavorite: (memo: MemoWithTags) => void
  onComment: (memo: MemoWithTags) => void
  onRepost: (memo: MemoWithTags) => void
  onFilter: () => void
  filterActive: boolean
}

/** 条目展示时间：转发按转发时间，memo 按创建时间 */
function itemTime(item: TimelineItem, deleted: boolean): number {
  if (deleted && item.memo.deletedAt) {
    return new Date(item.memo.deletedAt).getTime()
  }
  return item.kind === 'repost' && item.repost
    ? new Date(item.repost.createdAt).getTime()
    : new Date(item.memo.createdAt).getTime()
}

/** 按本地日期分组（今天/昨天/日期） */
function groupByDay(
  items: TimelineItem[],
  deleted: boolean,
): Array<{
  label: string
  date: string
  items: TimelineItem[]
}> {
  const groups: Array<{ label: string; date: string; items: TimelineItem[] }> =
    []
  for (const memo of items) {
    const d = new Date(itemTime(memo, deleted))
    const dateKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const last = groups.at(-1)
    if (last && last.date === dateKey) {
      last.items.push(memo)
    } else {
      groups.push({ label: dayLabel(d), date: dateKey, items: [memo] })
    }
  }
  return groups
}

/**
 * 单栏时间线：按日期分组 + IntersectionObserver 无限滚动。
 */
export function MemoFeed({
  items,
  hasMore,
  loading,
  onLoadMore,
  onTogglePin,
  onEdit,
  onReference,
  onToggleArchive,
  onDelete,
  deleted = false,
  onRestore,
  onPurge,
  onToggleVisibility,
  onLike,
  onFavorite,
  onComment,
  onRepost,
  onFilter,
  filterActive,
}: MemoFeedProps) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const groups = useMemo(() => groupByDay(items, deleted), [deleted, items])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loading) {
          onLoadMore()
        }
      },
      { rootMargin: '200px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loading, onLoadMore])

  return (
    <div className="grid gap-8">
      {groups.map((group, index) => (
        <section key={group.date} aria-label={group.label}>
          <div className="mb-3 flex items-center gap-3">
            <h2 className="shrink-0 font-mono text-xs text-kumo-subtle">
              {group.label}
            </h2>
            <div className="h-px flex-1 bg-kumo-line" />
            {index === 0 && (
              <Button
                variant="ghost"
                shape="square"
                icon={
                  <Funnel
                    size={16}
                    weight={filterActive ? 'fill' : 'regular'}
                  />
                }
                aria-label="筛选"
                title="筛选"
                onClick={onFilter}
              />
            )}
          </div>
          <div className="grid min-w-0 gap-2">
            {group.items.map((item) => (
              <MemoCard
                key={`${item.kind}-${item.memo.id}`}
                memo={item.memo}
                author={item.author}
                repost={item.repost}
                deleted={deleted}
                onTogglePin={deleted ? undefined : onTogglePin}
                onEdit={deleted ? undefined : onEdit}
                onReference={deleted ? undefined : onReference}
                onToggleArchive={deleted ? undefined : onToggleArchive}
                onDelete={deleted ? undefined : onDelete}
                onRestore={deleted ? onRestore : undefined}
                onPurge={deleted ? onPurge : undefined}
                onToggleVisibility={deleted ? undefined : onToggleVisibility}
                onLike={onLike}
                onFavorite={onFavorite}
                onComment={onComment}
                onRepost={onRepost}
              />
            ))}
          </div>
        </section>
      ))}

      {loading && (
        <div className="flex justify-center py-6">
          <Loader size="sm" />
        </div>
      )}

      {/* 无限滚动哨兵 */}
      <div ref={sentinelRef} aria-hidden="true" className="h-px" />
    </div>
  )
}
