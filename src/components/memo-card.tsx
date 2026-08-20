import { memo as memoize } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowBendUpRight,
  GlobeSimple,
  LockSimple,
  PushPin,
} from '@phosphor-icons/react'

import { authClient } from '#/lib/auth-client'
import type { MemoWithTags } from '#/server/memos'
import type { MemoAuthor, RepostContext } from '#/server/timeline-core'
import { relativeTime } from '#/lib/date'
import { Avatar } from './avatar'
import { HashtagText } from './hashtag-text'
import { MemoActions } from './memo-actions'
import { MemoInteractions } from './memo-interactions'

interface MemoCardProps {
  memo: MemoWithTags
  onTogglePin?: (memo: MemoWithTags) => void
  onToggleGlobalPin?: (memo: MemoWithTags) => void
  onEdit?: (memo: MemoWithTags) => void
  onReference?: (memo: MemoWithTags) => void
  onToggleArchive?: (memo: MemoWithTags) => void
  onDelete?: (memo: MemoWithTags) => void
  deleted?: boolean
  onRestore?: (memo: MemoWithTags) => void
  onPurge?: (memo: MemoWithTags) => void
  onToggleVisibility?: (memo: MemoWithTags) => void
  onLike: (memo: MemoWithTags) => void
  onFavorite: (memo: MemoWithTags) => void
  onComment: (memo: MemoWithTags) => void
  onRepost: (memo: MemoWithTags) => void
  /** 公开页归属用户名（用于公开主页/转发场景，默认取当前登录用户） */
  profileUsername?: string
  /** memo 原作者（他人 memo 展示作者头；自己的 memo 传 null/省略以显示操作） */
  author?: MemoAuthor | null
  /** 转发上下文（转发了谁的 memo + 附言 + 时间） */
  repost?: RepostContext | null
  /** 标签点击回调（默认跳到首页按标签筛选） */
  onTagClick?: (tag: string) => void
  /** 公共页面：该页面的 memo 全部公开，隐藏可见性图标 */
  hideVisibility?: boolean
  /** 是否展示作者自己的置顶状态；/explore 只展示全局置顶 */
  showUserPin?: boolean
}

export const MemoCard = memoize(function MemoCard({
  memo,
  onTogglePin,
  onToggleGlobalPin,
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
  profileUsername,
  author,
  repost,
  onTagClick,
  hideVisibility,
  showUserPin = true,
}: MemoCardProps) {
  const navigate = useNavigate()
  const { data: session } = authClient.useSession()
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- session 可能为 null
  const myUsername = session?.user?.username
  const username = author?.username ?? profileUsername ?? myUsername

  function openMemoPage() {
    if (deleted) return
    const ownMemo =
      !author && (!profileUsername || profileUsername === myUsername)
    if (ownMemo) {
      void navigate({ to: '/memo/$memoId', params: { memoId: memo.id } })
      return
    }
    if (!username) return
    void navigate({
      to: '/@{$username}/$memoId',
      params: { username, memoId: memo.id },
    })
  }

  function openProfile(target?: { username?: string }) {
    if (!target?.username) return
    void navigate({
      to: '/@{$username}',
      params: { username: target.username },
    })
  }

  let visibilityIcon: ReactNode
  if (hideVisibility) {
    visibilityIcon = null
  } else if (memo.visibility === 'public') {
    visibilityIcon = (
      <span
        role="img"
        aria-label="公开"
        title="公开"
        className="flex h-lh items-center text-kumo-subtle"
      >
        <GlobeSimple size={12} weight="fill" />
      </span>
    )
  } else {
    visibilityIcon = (
      <span
        role="img"
        aria-label="仅自己可见"
        title="仅自己可见"
        className="flex h-lh items-center text-kumo-inactive"
      >
        <LockSimple size={12} />
      </span>
    )
  }

  return (
    <article className="group relative min-w-0 overflow-hidden rounded-2xl bg-kumo-base ring ring-kumo-line hover:ring-accent/45 focus-within:ring-accent/60">
      <div className="relative px-5 pb-3.5 pt-[18px] sm:px-6 sm:pb-4 sm:pt-5">
        {repost && (
          <div className="mb-3 flex flex-wrap items-start gap-x-1.5 gap-y-0.5 text-xs text-kumo-subtle">
            <span className="h-lh flex shrink-0 items-center">
              <ArrowBendUpRight size={12} />
            </span>
            <span className="font-medium">转发了</span>
            <button
              type="button"
              onClick={() => openProfile(repost.reposter)}
              className="font-mono text-[0.9em] hover:text-kumo-default"
            >
              @{repost.reposter.username}
            </button>
            <span aria-hidden="true">·</span>
            <time
              dateTime={repost.createdAt}
              className="font-mono text-[0.9em]"
            >
              {relativeTime(repost.createdAt)}
            </time>
          </div>
        )}
        {repost?.content && (
          <div className="mb-3 rounded-lg bg-kumo-tint px-4 py-2.5 text-sm text-kumo-subtle">
            <HashtagText content={repost.content} onTagClick={onTagClick} />
          </div>
        )}
        {author && (
          <div className="mb-4 flex items-center gap-2.5">
            <Avatar
              username={author.username}
              image={author.image}
              size={28}
              className="shrink-0"
            />
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => openProfile(author)}
                className="block max-w-full truncate text-left text-sm font-medium text-kumo-default hover:text-accent"
              >
                {author.name}
              </button>
              <button
                type="button"
                onClick={() => openProfile(author)}
                className="block max-w-full truncate text-left font-mono text-xs text-kumo-subtle hover:text-accent"
              >
                @{author.username}
              </button>
            </div>
          </div>
        )}
        <div className="max-w-[52ch] text-[15px] leading-[1.75] text-kumo-strong sm:text-base sm:leading-[1.7]">
          <HashtagText content={memo.content} onTagClick={onTagClick} />
        </div>

        {(memo.globalPinned || (showUserPin && memo.pinned)) && (
          <div className="mt-4 flex items-center gap-2.5">
            {memo.globalPinned && (
              <span className="flex items-center gap-1 text-xs text-accent">
                <PushPin size={12} weight="fill" />
                <span className="font-mono">全局置顶</span>
              </span>
            )}
            {showUserPin && memo.pinned && (
              <span className="flex items-center gap-1 text-xs text-kumo-subtle">
                <PushPin size={12} weight="fill" />
                <span className="font-mono">置顶</span>
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-kumo-line bg-kumo-tint/45 px-5 py-2.5 sm:px-6">
        {deleted ? (
          <span className="font-mono text-xs text-kumo-subtle">
            {memo.deletedAt
              ? `删除于 ${relativeTime(memo.deletedAt)}`
              : '已删除'}
          </span>
        ) : (
          <MemoInteractions
            memo={memo}
            onLike={onLike}
            onFavorite={onFavorite}
            onComment={onComment}
            onRepost={onRepost}
          />
        )}
        <span className="flex shrink-0 items-center gap-2.5">
          {!deleted && visibilityIcon}
          {!deleted && username ? (
            <button
              type="button"
              onClick={openMemoPage}
              title="查看 memo 详情页"
              className="font-mono text-xs text-kumo-subtle hover:text-accent"
            >
              <time dateTime={memo.createdAt}>
                {relativeTime(memo.createdAt)}
              </time>
            </button>
          ) : !deleted ? (
            <time
              dateTime={memo.createdAt}
              className="font-mono text-xs text-kumo-subtle"
            >
              {relativeTime(memo.createdAt)}
            </time>
          ) : null}
          {(deleted ||
            onTogglePin ||
            onToggleGlobalPin ||
            onEdit ||
            onReference ||
            onToggleArchive ||
            onDelete ||
            onToggleVisibility) && (
            <MemoActions
              pinned={memo.pinned}
              globalPinned={memo.globalPinned}
              archived={memo.archived}
              visibility={memo.visibility}
              deleted={deleted}
              onTogglePin={onTogglePin ? () => onTogglePin(memo) : undefined}
              onToggleGlobalPin={
                onToggleGlobalPin ? () => onToggleGlobalPin(memo) : undefined
              }
              onToggleVisibility={
                onToggleVisibility ? () => onToggleVisibility(memo) : undefined
              }
              onEdit={onEdit ? () => onEdit(memo) : undefined}
              onReference={onReference ? () => onReference(memo) : undefined}
              onToggleArchive={
                onToggleArchive ? () => onToggleArchive(memo) : undefined
              }
              onDelete={onDelete ? () => onDelete(memo) : undefined}
              onRestore={onRestore ? () => onRestore(memo) : undefined}
              onPurge={onPurge ? () => onPurge(memo) : undefined}
            />
          )}
        </span>
      </div>
    </article>
  )
})
