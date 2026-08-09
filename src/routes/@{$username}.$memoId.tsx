import {
  createFileRoute,
  notFound,
  useLoaderData,
  useNavigate,
} from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  InputArea,
  Loader,
  useKumoToastManager,
} from '@cloudflare/kumo'
import {
  ArrowLeft,
  GlobeSimple,
  LockSimple,
  PaperPlaneRight,
  Trash,
} from '@phosphor-icons/react'

import { authClient } from '#/lib/auth-client'
import { relativeTime } from '#/lib/date'
import { Avatar } from '#/components/avatar'
import { HashtagText } from '#/components/hashtag-text'
import { MemoInteractions } from '#/components/memo-interactions'
import { RepostDialog } from '#/components/repost-dialog'
import {
  addComment,
  deleteComment,
  listComments,
  toggleFavorite,
  toggleLike,
} from '#/server/interactions'
import type { CommentItem, MemoCounts } from '#/server/interactions-core'
import { getPublicMemo } from '#/server/public'
import type { MemoWithTags } from '#/server/memos'

export const Route = createFileRoute('/@{$username}/$memoId')({
  loader: async ({ params }) => {
    const detail = await getPublicMemo({
      data: { username: params.username, memoId: params.memoId },
    })
    if (!detail) throw notFound()
    return detail
  },
  component: MemoPage,
})

function MemoPage() {
  const detail = useLoaderData({ from: '/@{$username}/$memoId' })
  const navigate = useNavigate()
  const toast = useKumoToastManager()
  const { data: session } = authClient.useSession()
  const [memo, setMemo] = useState<MemoWithTags>(detail.memo)
  const [comments, setComments] = useState<CommentItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingComments, setLoadingComments] = useState(true)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [repostOpen, setRepostOpen] = useState(false)
  const reqIdRef = useRef(0)

  const loadComments = useCallback(
    async (page: 'first' | 'next') => {
      const id = ++reqIdRef.current
      setLoadingComments(true)
      try {
        const res = await listComments({
          data: {
            memoId: memo.id,
            cursor:
              page === 'next' ? (cursorRef.current ?? undefined) : undefined,
            limit: 20,
          },
        })
        if (id !== reqIdRef.current) return
        setComments((prev) =>
          page === 'first' ? res.items : [...prev, ...res.items],
        )
        setCursor(res.nextCursor)
        setHasMore(res.nextCursor !== null)
      } catch {
        if (id === reqIdRef.current) {
          toast.add({ title: '评论加载失败', variant: 'error' })
        }
      } finally {
        if (id === reqIdRef.current) setLoadingComments(false)
      }
    },
    [memo.id],
  )
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor

  useEffect(() => {
    void loadComments('first')
  }, [memo.id])

  function requireLogin(): boolean {
    if (session?.user) return true
    void navigate({ to: '/login' })
    return false
  }

  async function handleLike() {
    if (!requireLogin()) return
    try {
      const res = await toggleLike({ data: { memoId: memo.id } })
      setMemo((m) => ({
        ...m,
        counts: res.counts,
        viewerState: { ...m.viewerState, liked: res.liked },
      }))
    } catch (err) {
      toast.add({
        title: '点赞失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    }
  }

  async function handleFavorite() {
    if (!requireLogin()) return
    try {
      const res = await toggleFavorite({ data: { memoId: memo.id } })
      setMemo((m) => ({
        ...m,
        counts: res.counts,
        viewerState: { ...m.viewerState, favorited: res.favorited },
      }))
    } catch (err) {
      toast.add({
        title: '收藏失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    }
  }

  function handleRepost() {
    if (!requireLogin()) return
    setRepostOpen(true)
  }

  function handleReposted(
    counts: MemoCounts,
    reposted: boolean,
    content: string | null,
  ) {
    setMemo((m) => ({
      ...m,
      counts,
      viewerState: {
        ...m.viewerState,
        reposted,
        repostedContent: content,
      },
    }))
  }

  async function handleSendComment() {
    const content = draft.trim()
    if (!content || sending) return
    if (!requireLogin()) return
    setSending(true)
    try {
      const comment = await addComment({ data: { memoId: memo.id, content } })
      setComments((prev) => [...prev, comment])
      setDraft('')
      setMemo((m) => ({
        ...m,
        counts: { ...m.counts, comments: m.counts.comments + 1 },
      }))
    } catch (err) {
      toast.add({
        title: '评论失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    } finally {
      setSending(false)
    }
  }

  async function handleDeleteComment(comment: CommentItem) {
    try {
      const res = await deleteComment({ data: { commentId: comment.id } })
      if (res.deleted) {
        setComments((prev) => prev.filter((c) => c.id !== comment.id))
        setMemo((m) => ({
          ...m,
          counts: { ...m.counts, comments: Math.max(0, m.counts.comments - 1) },
        }))
      }
    } catch {
      toast.add({ title: '删除失败', variant: 'error' })
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- session 可能为 null
  const viewerId = session?.user?.id
  const isAuthor = viewerId === detail.author.id

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
            onClick={() =>
              void navigate({
                to: '/@{$username}',
                params: { username: detail.author.username },
              })
            }
          />
          <div className="text-sm font-semibold text-kumo-strong">memo</div>
          <span className="font-mono text-xs text-kumo-subtle">
            @{detail.author.username}
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[640px] px-4 pb-24 pt-8">
        <article className="rounded-xl bg-kumo-base px-5 py-4 ring ring-kumo-line">
          <div className="mb-4 flex items-center gap-2.5">
            <Avatar image={detail.author.image} size={36} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-kumo-default">
                {detail.author.name}
              </p>
              <p className="font-mono text-xs text-kumo-subtle">
                @{detail.author.username}
              </p>
            </div>
            <time
              dateTime={memo.createdAt}
              className="ml-auto shrink-0 font-mono text-xs text-kumo-subtle"
            >
              {relativeTime(memo.createdAt)}
            </time>
          </div>

          <div className="text-sm leading-relaxed text-kumo-default">
            <HashtagText content={memo.content} />
          </div>

          <div className="mt-3 flex items-center gap-2.5">
            {memo.visibility === 'public' ? (
              <span className="flex items-center gap-1 text-xs text-kumo-subtle">
                <GlobeSimple size={12} weight="fill" />
                <span className="font-mono">公开</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-kumo-inactive">
                <LockSimple size={12} />
                <span className="font-mono">仅自己可见</span>
              </span>
            )}
            {isAuthor && memo.archived && (
              <span className="font-mono text-xs text-kumo-subtle">已归档</span>
            )}
            {memo.tags.length > 0 && (
              <span className="font-mono text-xs text-kumo-subtle">
                {memo.tags.map((t) => t.name).join(' #')}
              </span>
            )}
          </div>

          <div className="mt-3 border-t border-kumo-line pt-2.5">
            <MemoInteractions
              memo={memo}
              onLike={() => void handleLike()}
              onFavorite={() => void handleFavorite()}
              onComment={() => {
                if (!requireLogin()) return
                document.getElementById('memo-comment-input')?.focus()
              }}
              onRepost={() => void handleRepost()}
            />
          </div>
        </article>

        <section className="mt-8" aria-label="评论">
          <h2 className="mb-3 font-mono text-xs text-kumo-subtle">
            评论 · {memo.counts.comments}
          </h2>

          <div className="mb-5 flex items-end gap-2">
            <InputArea
              id="memo-comment-input"
              autoResize
              minRows={1}
              maxRows={5}
              placeholder="写下你的评论…"
              aria-label="新评论"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-9 w-full px-4 py-2 text-sm"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  void handleSendComment()
                }
              }}
            />
            <Button
              variant="primary"
              shape="square"
              icon={<PaperPlaneRight size={15} />}
              loading={sending}
              disabled={!draft.trim()}
              onClick={() => void handleSendComment()}
              aria-label="发送评论"
            />
          </div>

          {loadingComments ? (
            <div className="flex justify-center py-8">
              <Loader size="sm" />
            </div>
          ) : comments.length === 0 ? (
            <p className="py-8 text-center text-sm text-kumo-subtle">
              还没有评论。
            </p>
          ) : (
            <div className="grid gap-4">
              {comments.map((comment) => (
                <div key={comment.id} className="flex items-start gap-2.5">
                  <Avatar
                    image={comment.author.image}
                    size={28}
                    className="mt-0.5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium text-kumo-default">
                        {comment.author.name}
                      </span>
                      <span className="font-mono text-xs text-kumo-subtle">
                        @{comment.author.username}
                      </span>
                      <time
                        dateTime={comment.createdAt}
                        className="font-mono text-xs text-kumo-inactive"
                      >
                        {relativeTime(comment.createdAt)}
                      </time>
                      {viewerId === comment.author.id && (
                        <button
                          type="button"
                          onClick={() => void handleDeleteComment(comment)}
                          aria-label="删除评论"
                          title="删除评论"
                          className="ml-auto flex items-center rounded p-0.5 text-kumo-inactive hover:bg-kumo-tint hover:text-kumo-danger"
                        >
                          <Trash size={13} />
                        </button>
                      )}
                    </div>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-kumo-default">
                      {comment.content}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
          {hasMore && !loadingComments && (
            <div className="py-4 text-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void loadComments('next')}
              >
                加载更多
              </Button>
            </div>
          )}
        </section>
      </main>

      <RepostDialog
        open={repostOpen}
        onOpenChange={setRepostOpen}
        memo={memo}
        onReposted={handleReposted}
      />
    </div>
  )
}
