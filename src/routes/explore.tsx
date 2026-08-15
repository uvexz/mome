import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useState } from 'react'
import {
  useQueryClient,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { Button, Loader, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowLeft, GlobeSimple, X } from '@phosphor-icons/react'
import { z } from 'zod'

import { authClient } from '#/lib/auth-client'
import { LoginDialog } from '#/components/login-forms'
import { MemoCard } from '#/components/memo-card'
import { MemoCommentsDialog } from '#/components/memo-comments-dialog'
import { RepostDialog } from '#/components/repost-dialog'
import { UserMenu } from '#/components/user-menu'
import {
  adminGateQueryOptions,
  appConfigQueryOptions,
  mapInfiniteItems,
  publicTimelineQueryOptions,
  queryKeys,
} from '#/lib/queries'
import { toggleGlobalPin } from '#/server/admin'
import { toggleFavorite, toggleLike } from '#/server/interactions'
import type { MemoCounts } from '#/server/interactions-core'
import type { MemoWithTags } from '#/server/memos'

export const Route = createFileRoute('/explore')({
  validateSearch: z.object({
    tag: z.string().max(100).optional(),
  }),
  loaderDeps: ({ search }) => ({ tag: search.tag }),
  loader: async ({ context, deps }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(appConfigQueryOptions()),
      context.queryClient.ensureQueryData(adminGateQueryOptions()),
      context.queryClient.ensureInfiniteQueryData(
        publicTimelineQueryOptions(deps.tag),
      ),
    ])
  },
  component: ExplorePage,
})

function ExplorePage() {
  const search = useSearch({ from: '/explore' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const { data: config } = useSuspenseQuery(appConfigQueryOptions())
  const { data: gate } = useSuspenseQuery(adminGateQueryOptions())
  const timelineOptions = publicTimelineQueryOptions(search.tag)
  const timeline = useSuspenseInfiniteQuery(timelineOptions)
  const items = timeline.data.pages.flatMap((page) => page.items)
  const { data: session } = authClient.useSession()
  const [commenting, setCommenting] = useState<MemoWithTags | null>(null)
  const [commentOpen, setCommentOpen] = useState(false)
  const [reposting, setReposting] = useState<MemoWithTags | null>(null)
  const [repostOpen, setRepostOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)

  function updateTag(tag?: string) {
    void navigate({
      to: '/explore',
      search: (prev) => ({ ...prev, tag: tag || undefined }),
      replace: false,
    })
  }

  function requireLogin(): boolean {
    if (session?.user) return true
    void navigate({ to: '/login' })
    return false
  }

  function patchItem(id: string, patch: Partial<MemoWithTags>) {
    queryClient.setQueryData(timelineOptions.queryKey, (data) =>
      mapInfiniteItems(data, (item) =>
        item.memo.id === id
          ? { ...item, memo: { ...item.memo, ...patch } }
          : item,
      ),
    )
  }

  function markRelatedQueriesStale() {
    for (const queryKey of [
      queryKeys.memos,
      queryKeys.public,
      queryKeys.interactions,
    ]) {
      void queryClient.invalidateQueries({ queryKey, refetchType: 'none' })
    }
  }

  async function handleToggleGlobalPin(memo: MemoWithTags) {
    try {
      const res = await toggleGlobalPin({ data: { memoId: memo.id } })
      await queryClient.invalidateQueries({ queryKey: queryKeys.public })
      toast.add({
        title: res.globalPinned ? '已全局置顶' : '已取消全局置顶',
        variant: 'success',
      })
    } catch (err) {
      toast.add({
        title: '操作失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    }
  }

  async function handleLike(memo: MemoWithTags) {
    if (!requireLogin()) return
    try {
      const res = await toggleLike({ data: { memoId: memo.id } })
      patchItem(memo.id, {
        counts: res.counts,
        viewerState: { ...memo.viewerState, liked: res.liked },
      })
      markRelatedQueriesStale()
    } catch (err) {
      toast.add({
        title: '点赞失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    }
  }

  async function handleFavorite(memo: MemoWithTags) {
    if (!requireLogin()) return
    try {
      const res = await toggleFavorite({ data: { memoId: memo.id } })
      patchItem(memo.id, {
        counts: res.counts,
        viewerState: { ...memo.viewerState, favorited: res.favorited },
      })
      markRelatedQueriesStale()
    } catch (err) {
      toast.add({
        title: '收藏失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    }
  }

  function handleComment(memo: MemoWithTags) {
    if (!requireLogin()) return
    setCommenting(memo)
    setCommentOpen(true)
  }

  function handleRepost(memo: MemoWithTags) {
    if (!requireLogin()) return
    setReposting(memo)
    setRepostOpen(true)
  }

  function handleReposted(
    memo: MemoWithTags,
    counts: MemoCounts,
    reposted: boolean,
    content: string | null,
  ) {
    patchItem(memo.id, {
      counts,
      viewerState: {
        ...memo.viewerState,
        reposted,
        repostedContent: content,
      },
    })
  }

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-kumo-line bg-kumo-canvas/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[640px] items-center gap-3 px-4">
          {session?.user ? (
            <Button
              variant="ghost"
              shape="square"
              icon={<ArrowLeft size={16} />}
              aria-label="返回"
              title="返回"
              onClick={() => void navigate({ to: '/' })}
            />
          ) : (
            <a
              href="/"
              className="flex shrink-0 items-center gap-2 text-sm font-semibold text-kumo-strong"
            >
              <img
                src={config.siteIcon}
                alt={config.siteName}
                className="h-6 w-6 object-contain"
              />
              {config.siteName}
            </a>
          )}
          {session?.user && (
            <div className="flex items-center gap-2 text-sm font-semibold text-kumo-strong">
              <GlobeSimple size={16} weight="duotone" className="text-accent" />
              公共主页
            </div>
          )}
          <div className="flex-1" />
          {session?.user ? (
            <UserMenu />
          ) : (
            <Button
              variant="primary"
              size="sm"
              className="h-8"
              onClick={() => setLoginOpen(true)}
            >
              登录
            </Button>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-[640px] px-4 pb-24 pt-8">
        {!session?.user && (
          <section className="mb-8 grid gap-3 text-center">
            <h1 className="text-lg font-semibold text-kumo-strong">
              记录碎片想法，与所有人分享
            </h1>
            <p className="text-sm text-kumo-subtle">{config.siteDescription}</p>
            <div className="mt-1 flex items-center justify-center gap-2">
              <Button
                variant="primary"
                size="sm"
                className="h-8"
                onClick={() => setLoginOpen(true)}
              >
                登录
              </Button>
              {config.allowSignup && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-8"
                  onClick={() => void navigate({ to: '/signup' })}
                >
                  注册
                </Button>
              )}
            </div>
          </section>
        )}

        {search.tag && (
          <div className="mb-4 flex items-center gap-2">
            <button
              type="button"
              onClick={() => updateTag()}
              className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-xs font-medium text-kumo-canvas"
            >
              <span>#{search.tag}</span>
              <X size={12} />
            </button>
            <span className="text-xs text-kumo-subtle">
              正在按标签筛选全部用户的公开 memo
            </span>
          </div>
        )}

        {items.length === 0 ? (
          <p className="py-16 text-center text-sm text-kumo-subtle">
            {search.tag
              ? `#${search.tag} 下还没有公开 memo`
              : '还没有公开 memo。'}
          </p>
        ) : (
          <div className="grid gap-2">
            {items.map((item) => (
              <MemoCard
                key={`${item.kind}-${item.memo.id}`}
                memo={item.memo}
                profileUsername={item.author?.username}
                author={item.author}
                repost={item.repost}
                hideVisibility
                showUserPin={false}
                onToggleGlobalPin={
                  gate.isAdmin
                    ? (m) => void handleToggleGlobalPin(m)
                    : undefined
                }
                onTagClick={(tag) => updateTag(tag)}
                onLike={(m) => void handleLike(m)}
                onFavorite={(m) => void handleFavorite(m)}
                onComment={handleComment}
                onRepost={handleRepost}
              />
            ))}
          </div>
        )}

        {timeline.hasNextPage && !timeline.isFetchingNextPage && (
          <div className="py-6 text-center">
            <Button
              variant="secondary"
              onClick={() => void timeline.fetchNextPage()}
            >
              加载更多
            </Button>
          </div>
        )}
        {timeline.isFetchingNextPage && (
          <div className="flex justify-center py-6">
            <Loader size="sm" />
          </div>
        )}
      </main>

      <MemoCommentsDialog
        open={commentOpen}
        onOpenChange={setCommentOpen}
        memo={commenting}
        onCountsChange={(counts) =>
          commenting && patchItem(commenting.id, { counts })
        }
      />
      <RepostDialog
        open={repostOpen}
        onOpenChange={setRepostOpen}
        memo={reposting}
        onReposted={(counts, reposted, content) =>
          reposting && handleReposted(reposting, counts, reposted, content)
        }
      />
      <LoginDialog
        open={loginOpen}
        onOpenChange={setLoginOpen}
        onDone={() => void navigate({ to: '/' })}
      />
    </div>
  )
}
