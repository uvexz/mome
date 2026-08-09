import { Button, Empty } from '@cloudflare/kumo'
import { NotePencil } from '@phosphor-icons/react'

interface EmptyStateProps {
  hasFilters: boolean
  onClear: () => void
  view?: 'default' | 'archived' | 'deleted'
}

export function EmptyState({
  hasFilters,
  onClear,
  view = 'default',
}: EmptyStateProps) {
  const deleted = view === 'deleted'
  const archived = view === 'archived'
  return (
    <Empty
      size="lg"
      icon={<NotePencil size={48} className="text-kumo-inactive" />}
      title={
        hasFilters
          ? '没有匹配的 memo'
          : deleted
            ? '回收站为空'
            : archived
              ? '还没有归档 memo'
              : '写下第一条 mome'
      }
      description={
        hasFilters
          ? '换个关键词或标签试试。'
          : deleted
            ? '删除的 memo 会暂时保留在这里。'
            : archived
              ? '归档后的 memo 会显示在这里。'
              : '在顶部的输入框记录此刻的想法，用 #标签 归类。'
      }
      contents={
        hasFilters ? (
          <Button variant="secondary" onClick={onClear}>
            清除筛选
          </Button>
        ) : undefined
      }
    />
  )
}
