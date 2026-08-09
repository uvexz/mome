import { memo as memoize } from 'react'
import {
  ArrowBendUpRight,
  BookmarkSimple,
  ChatCircle,
  Heart,
} from '@phosphor-icons/react'

import { compactNumber, cn } from '#/lib/utils'
import type { MemoWithTags } from '#/server/memos'

interface MemoInteractionsProps {
  memo: MemoWithTags
  onLike: (memo: MemoWithTags) => void
  onFavorite: (memo: MemoWithTags) => void
  onComment: (memo: MemoWithTags) => void
  onRepost: (memo: MemoWithTags) => void
}

/**
 * memo 互动栏：点赞 / 收藏 / 评论 / 转发。
 * 计数与激活态来自 memo.counts / memo.viewerState。
 */
export const MemoInteractions = memoize(function MemoInteractions({
  memo,
  onLike,
  onFavorite,
  onComment,
  onRepost,
}: MemoInteractionsProps) {
  const { counts, viewerState } = memo

  return (
    <div className="flex items-center gap-1">
      <InteractionButton
        label={viewerState.liked ? '取消点赞' : '点赞'}
        active={viewerState.liked}
        count={counts.likes}
        icon={
          <Heart size={15} weight={viewerState.liked ? 'fill' : 'regular'} />
        }
        onClick={() => onLike(memo)}
      />
      <InteractionButton
        label={viewerState.favorited ? '取消收藏' : '收藏'}
        active={viewerState.favorited}
        count={counts.favorites}
        icon={
          <BookmarkSimple
            size={15}
            weight={viewerState.favorited ? 'fill' : 'regular'}
          />
        }
        onClick={() => onFavorite(memo)}
      />
      <InteractionButton
        label="评论"
        active={false}
        count={counts.comments}
        icon={<ChatCircle size={15} />}
        onClick={() => onComment(memo)}
      />
      <InteractionButton
        label={viewerState.reposted ? '已转发' : '转发'}
        active={viewerState.reposted}
        count={counts.reposts}
        icon={
          <ArrowBendUpRight
            size={15}
            weight={viewerState.reposted ? 'fill' : 'regular'}
          />
        }
        onClick={() => onRepost(memo)}
      />
    </div>
  )
})

function InteractionButton({
  label,
  active,
  count,
  icon,
  onClick,
}: {
  label: string
  active: boolean
  count: number
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={`${label}${count > 0 ? `（${count}）` : ''}`}
      className={cn(
        'flex h-lh items-center justify-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium',
        active
          ? 'text-accent'
          : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default',
      )}
    >
      <span className="flex items-center">{icon}</span>
      <span className="font-mono tabular-nums">{compactNumber(count)}</span>
    </button>
  )
}
