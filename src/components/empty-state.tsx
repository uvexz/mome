import { Button, Empty } from '@cloudflare/kumo'
import { NotePencil } from '@phosphor-icons/react'

interface EmptyStateProps {
  hasFilters: boolean
  onClear: () => void
}

export function EmptyState({ hasFilters, onClear }: EmptyStateProps) {
  return (
    <Empty
      size="lg"
      icon={<NotePencil size={48} className="text-kumo-inactive" />}
      title={hasFilters ? '没有匹配的 memo' : '写下第一条 mome'}
      description={
        hasFilters
          ? '换个关键词或标签试试。'
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
