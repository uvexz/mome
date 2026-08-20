import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import {
  useQueryClient,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from '@tanstack/react-query'
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
  commentsQueryOptions,
  mapInfiniteItems,
  publicMemoQueryOptions,
  queryKeys,
} from '#/lib/queries'
import {
  addComment,
  deleteComment,
  toggleFavorite,
  toggleLike,
} from '#/server/interactions'
import type { CommentItem, MemoCounts } from '#/server/interactions-core'
import type { MemoWithTags } from '#/server/memos'

export const Route = createFileRoute('/@{$username}/$memoId')({
  loader: async ({ context, params }) => {
    const username = params.username.toLowerCase()
    const detail = await context.queryClient.ensureQueryData(
      publicMemoQueryOptions(username, params.memoId),
    )
    if (!detail) throw notFound()
    await context.queryClient.ensureInfiniteQueryData(
      commentsQueryOptions(params.memoId),
    )
  },
  component: MemoPage,
})

function MemoPage() {
  const params = Route.useParams()
  const detailOptions = publicMemoQueryOptions(
    params.username.toLowerCase(),
    params.memoId,
  )
  const { data: loadedDetail } = useSuspenseQuery(detailOptions)
  const detail = loadedDetail!
  const commentsOptions = commentsQueryOptions(params.memoId)
  const commentsQuery = useSuspenseInfiniteQuery(commentsOptions)
  const comments = commentsQuery.data.pages.flatMap((page) => page.items)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const toast = useKumoToastManager()
  const { data: session } = authClient.useSession()
  const memo = detail.memo
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [repostOpen, setRepostOpen] = useState(false)
  function patchMemo(patch: Partial<MemoWithTags>) {
    queryClient.setQueryData(detailOptions.queryKey, (current) =>
      current ? { ...current, memo: { ...current.memo, ...patch } } : current,
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

  function requireLogin(): boolean {
    if (session?.user) return true
    void navigate({ to: '/login' })
    return false
  }

  async function handleLike() {
    if (!requireLogin()) return
    try {
      const res = await toggleLike({ data: { memoId: memo.id } })
      patchMemo({
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

  async function handleFavorite() {
    if (!requireLogin()) return
    try {
      const res = await toggleFavorite({ data: { memoId: memo.id } })
      patchMemo({
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

  function handleRepost() {
    if (!requireLogin()) return
    setRepostOpen(true)
  }

  function handleReposted(
    counts: MemoCounts,
    reposted: boolean,
    content: string | null,
  ) {
    patchMemo({
      counts,
      viewerState: {
        ...memo.viewerState,
        reposted,
        repostedContent: content,
      },
    })
    markRelatedQueriesStale()
  }

  async function handleSendComment() {
    const content = draft.trim()
    if (!content || sending) return
    if (!requireLogin()) return
    setSending(true)
    try {
      const result = await addComment({ data: { memoId: memo.id, content } })
      queryClient.setQueryData(commentsOptions.queryKey, (data) => {
        if (!data || data.pages.length === 0) return data
        const pages = [...data.pages]
        const index = pages.length - 1
        const page = pages[index]
        pages[index] = { ...page, items: [...page.items, result.comment] }
        return { ...data, pages }
      })
      setDraft('')
      patchMemo({ counts: result.counts })
      markRelatedQueriesStale()
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
        queryClient.setQueryData(commentsOptions.queryKey, (data) =>
          mapInfiniteItems(data, (item) =>
            item.id === comment.id ? null : item,
          ),
        )
        patchMemo({ counts: res.counts })
        markRelatedQueriesStale()
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
            <Avatar
              username={detail.author.username}
              image={detail.author.image}
              size={36}
            />
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
            <HashtagText
              content={memo.content}
              memoUsername={detail.author.username}
            />
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

          {comments.length === 0 ? (
            <p className="py-8 text-center text-sm text-kumo-subtle">
              还没有评论。
            </p>
          ) : (
            <div className="grid gap-4">
              {comments.map((comment) => (
                <div key={comment.id} className="flex items-start gap-2.5">
                  <Avatar
                    username={comment.author.username}
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
          {commentsQuery.hasNextPage && !commentsQuery.isFetchingNextPage && (
            <div className="py-4 text-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void commentsQuery.fetchNextPage()}
              >
                加载更多
              </Button>
            </div>
          )}
          {commentsQuery.isFetchingNextPage && (
            <div className="flex justify-center py-4">
              <Loader size="sm" />
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
