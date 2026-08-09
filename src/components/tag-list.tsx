import { memo } from 'react'

import type { TagWithCount } from '#/server/tags'
import { cn } from '#/lib/utils'

interface TagListProps {
  tags: TagWithCount[]
  currentTag?: string
  onSelect: (tag: string | null) => void
}

/**
 * 标签筛选条：按使用频次排序，扁平展示（子标签显示完整路径 #父/子/孙）。
 */
export const TagList = memo(function TagList({
  tags,
  currentTag,
  onSelect,
}: TagListProps) {
  if (tags.length === 0) return null

  const tagById = new Map(tags.map((t) => [t.id, t]))
  const rows = tags.map((t) => ({
    ...t,
    path: buildFullPath(t, tagById),
  }))

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="list">
      {rows.map((tag) => {
        const active = currentTag === tag.path
        return (
          <button
            key={tag.id}
            type="button"
            onClick={() => onSelect(active ? null : tag.path)}
            aria-pressed={active}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring ring-kumo-line',
              active
                ? 'bg-accent font-medium text-kumo-canvas ring-accent'
                : 'bg-kumo-base text-kumo-default hover:bg-kumo-tint',
            )}
          >
            <span>{`#${tag.path}`}</span>
            <span
              className={cn(
                'font-mono',
                active ? 'text-kumo-canvas/70' : 'text-kumo-subtle',
              )}
            >
              {tag.count}
            </span>
          </button>
        )
      })}
    </div>
  )
})

/** 由当前节点逐级向上拼出完整路径（支持任意深度） */
function buildFullPath(
  tag: TagWithCount,
  tagById: Map<string, TagWithCount>,
): string {
  const parts: string[] = []
  let current: TagWithCount | undefined = tag
  while (current) {
    parts.unshift(current.name)
    current = current.parentId ? tagById.get(current.parentId) : undefined
  }
  return parts.join('/')
}
