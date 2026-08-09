import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Loader, useKumoToastManager } from '@cloudflare/kumo'
import {
  ArrowBendUpRight,
  ArrowLeft,
  BookmarkSimple,
  ChatCircle,
  Heart,
} from '@phosphor-icons/react'

import { MemoCard } from '#/components/memo-card'
import { MemoCommentsDialog } from '#/components/memo-comments-dialog'
import { RepostDialog } from '#/components/repost-dialog'
import { relativeTime } from '#/lib/date'
import { cn } from '#/lib/utils'
import {
  toggleFavorite,
  toggleLike,
  listInteractions,
} from '#/server/interactions'
import type { MemoCounts } from '#/server/interactions-core'
import type { MemoWithTags } from '#/server/memos'
import { getSessionUser } from '#/server/session'
import type { InteractionItem, InteractionKind } from '#/server/timeline-core'

const PAGE_SIZE = 20

const TABS: Array<{
  key: InteractionKind
  label: string
  actionLabel: string
  icon: React.ReactNode
  empty: string
}> = [
  {
    key: 'likes',
    label: '点赞',
    actionLabel: '点赞了',
    icon: <Heart size={15} />,
    empty: '还没有点赞过的 memo。',
  },
  {
    key: 'favorites',
    label: '收藏',
    actionLabel: '收藏了',
    icon: <BookmarkSimple size={15} />,
    empty: '还没有收藏过的 memo。',
  },
  {
    key: 'comments',
    label: '回复',
    actionLabel: '回复了',
    icon: <ChatCircle size={15} />,
    empty: '还没有回复过的 memo。',
  },
  {
    key: 'reposts',
    label: '转发',
    actionLabel: '转发了',
    icon: <ArrowBendUpRight size={15} />,
    empty: '还没有转发过的 memo。',
  },
]

export const Route = createFileRoute('/interactions')({
  beforeLoad: async () => {
    const user = await getSessionUser()
    if (!user) throw redirect({ to: '/explore' })
  },
  component: InteractionsPage,
})

function InteractionsPage() {
  const navigate = useNavigate()
  const toast = useKumoToastManager()
  const [tab, setTab] = useState<InteractionKind>('likes')
  const [items, setItems] = useState<InteractionItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [commenting, setCommenting] = useState<MemoWithTags | null>(null)
  const [commentOpen, setCommentOpen] = useState(false)
  const [reposting, setReposting] = useState<MemoWithTags | null>(null)
  const [repostOpen, setRepostOpen] = useState(false)
  const reqIdRef = useRef(0)
  const cursorRef = useRef<string | null>(null)
  const tabRef = useRef(tab)
  tabRef.current = tab

  const load = useCallback(async (page: 'first' | 'next') => {
    const id = ++reqIdRef.current
    setLoading(true)
    try {
      const kind = tabRef.current
      const res = await listInteractions({
        data: {
          kind,
          cursor:
            page === 'next' ? (cursorRef.current ?? undefined) : undefined,
          limit: PAGE_SIZE,
        },
      })
      if (id !== reqIdRef.current) return
      setItems((prev) =>
        page === 'first' ? res.items : [...prev, ...res.items],
      )
      cursorRef.current = res.nextCursor
      setCursor(res.nextCursor)
    } catch {
      if (id === reqIdRef.current) {
        toast.add({ title: '加载失败', variant: 'error' })
      }
    } finally {
      if (id === reqIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setItems([])
    cursorRef.current = null
    setCursor(null)
    void load('first')
  }, [tab, load])

  function patchItem(id: string, patch: Partial<MemoWithTags>) {
    setItems((prev) =>
      prev.map((i) =>
        i.memo.id === id ? { ...i, memo: { ...i.memo, ...patch } } : i,
      ),
    )
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.memo.id !== id))
  }

  async function handleLike(memo: MemoWithTags) {
    try {
      const res = await toggleLike({ data: { memoId: memo.id } })
      if (!res.liked && tabRef.current === 'likes') {
        removeItem(memo.id)
      } else {
        patchItem(memo.id, {
          counts: res.counts,
          viewerState: { ...memo.viewerState, liked: res.liked },
        })
      }
    } catch (err) {
      toast.add({
        title: '点赞失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    }
  }

  async function handleFavorite(memo: MemoWithTags) {
    try {
      const res = await toggleFavorite({ data: { memoId: memo.id } })
      if (!res.favorited && tabRef.current === 'favorites') {
        removeItem(memo.id)
      } else {
        patchItem(memo.id, {
          counts: res.counts,
          viewerState: { ...memo.viewerState, favorited: res.favorited },
        })
      }
    } catch (err) {
      toast.add({
        title: '收藏失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    }
  }

  function handleReposted(
    memo: MemoWithTags,
    counts: MemoCounts,
    reposted: boolean,
    content: string | null,
  ) {
    if (!reposted && tabRef.current === 'reposts') {
      removeItem(memo.id)
      return
    }
    patchItem(memo.id, {
      counts,
      viewerState: {
        ...memo.viewerState,
        reposted,
        repostedContent: content,
      },
    })
  }

  const activeTab = TABS.find((t) => t.key === tab) ?? TABS[0]

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-kumo-line bg-kumo-canvas/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[640px] items-center gap-3 px-4">
          <Button
            variant="ghost"
            shape="square"
            icon={<ArrowLeft size={16} />}
            aria-label="返回"
            title="返回"
            onClick={() => void navigate({ to: '/' })}
          />
          <div className="text-sm font-semibold text-kumo-strong">互动</div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[640px] px-4 pb-24 pt-6">
        <div className="grid grid-cols-4 gap-1 rounded-lg bg-kumo-tint p-0.5 text-sm">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-medium',
                tab === t.key
                  ? 'bg-kumo-base text-kumo-strong ring ring-kumo-line'
                  : 'text-kumo-subtle hover:text-kumo-default',
              )}
            >
              <span className="flex items-center">{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        <section className="mt-6" aria-label={activeTab.label}>
          {loading && items.length === 0 ? (
            <div className="flex justify-center py-16">
              <Loader size="base" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-16 text-center text-sm text-kumo-subtle">
              {activeTab.empty}
            </p>
          ) : (
            <div className="grid gap-4">
              {items.map((item) => (
                <div
                  key={`${item.kind}-${item.memo.id}`}
                  className="grid gap-2"
                >
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-5 text-xs text-kumo-subtle">
                    <span className="font-medium">{activeTab.actionLabel}</span>
                    <span className="font-mono text-[0.9em]">
                      @{item.author.username}
                    </span>
                    <span aria-hidden="true">·</span>
                    <time
                      dateTime={item.interactedAt}
                      className="font-mono text-[0.9em]"
                    >
                      {relativeTime(item.interactedAt)}
                    </time>
                  </div>
                  {item.content && (
                    <div className="whitespace-pre-wrap rounded-lg bg-kumo-tint px-4 py-2.5 text-sm text-kumo-subtle">
                      {item.content}
                    </div>
                  )}
                  <MemoCard
                    memo={item.memo}
                    author={item.author}
                    onLike={(m) => void handleLike(m)}
                    onFavorite={(m) => void handleFavorite(m)}
                    onComment={(m) => {
                      setCommenting(m)
                      setCommentOpen(true)
                    }}
                    onRepost={(m) => {
                      setReposting(m)
                      setRepostOpen(true)
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          {cursor && !loading && (
            <div className="py-6 text-center">
              <Button variant="secondary" onClick={() => void load('next')}>
                加载更多
              </Button>
            </div>
          )}
          {loading && items.length > 0 && (
            <div className="flex justify-center py-6">
              <Loader size="sm" />
            </div>
          )}
        </section>
      </main>

      <MemoCommentsDialog
        open={commentOpen}
        onOpenChange={setCommentOpen}
        memo={commenting}
        onCountChange={(count) =>
          commenting &&
          setItems((prev) =>
            prev.map((i) =>
              i.memo.id === commenting.id
                ? {
                    ...i,
                    memo: {
                      ...i.memo,
                      counts: { ...i.memo.counts, comments: count },
                    },
                  }
                : i,
            ),
          )
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
    </div>
  )
}
