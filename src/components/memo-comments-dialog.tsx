import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  Dialog,
  InputArea,
  Loader,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { PaperPlaneRight, Trash, X } from '@phosphor-icons/react'

import { authClient } from '#/lib/auth-client'
import { relativeTime } from '#/lib/date'
import { addComment, deleteComment, listComments } from '#/server/interactions'
import type { CommentItem } from '#/server/interactions-core'
import type { MemoWithTags } from '#/server/memos'
import { Avatar } from './avatar'

interface MemoCommentsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  memo: MemoWithTags | null
  onCountChange: (count: number) => void
}

/**
 * 评论列表 + 发表评论（kumo Dialog，open 属性控制）。
 */
export function MemoCommentsDialog({
  open,
  onOpenChange,
  memo,
  onCountChange,
}: MemoCommentsDialogProps) {
  const toast = useKumoToastManager()
  const { data: session } = authClient.useSession()
  const [items, setItems] = useState<CommentItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState('')
  const reqIdRef = useRef(0)
  const cursorRef = useRef<string | null>(null)

  const load = useCallback(
    async (page: 'first' | 'next') => {
      if (!memo) return
      const id = ++reqIdRef.current
      setLoading(true)
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
        setItems((prev) =>
          page === 'first' ? res.items : [...prev, ...res.items],
        )
        cursorRef.current = res.nextCursor
        setHasMore(res.nextCursor !== null)
      } catch {
        if (id === reqIdRef.current) {
          toast.add({ title: '评论加载失败', variant: 'error' })
        }
      } finally {
        if (id === reqIdRef.current) setLoading(false)
      }
    },
    [memo],
  )

  useEffect(() => {
    if (open && memo) {
      setItems([])
      cursorRef.current = null
      setHasMore(false)
      setDraft('')
      void load('first')
    }
  }, [open, memo?.id])

  async function handleSend() {
    const content = draft.trim()
    if (!memo || !content || sending) return
    setSending(true)
    try {
      const comment = await addComment({ data: { memoId: memo.id, content } })
      setItems((prev) => [...prev, comment])
      setDraft('')
      onCountChange(memo.counts.comments + 1)
      toast.add({ title: '已评论', variant: 'success' })
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

  async function handleDelete(comment: CommentItem) {
    if (!memo) return
    try {
      const res = await deleteComment({ data: { commentId: comment.id } })
      if (res.deleted) {
        setItems((prev) => prev.filter((c) => c.id !== comment.id))
        onCountChange(Math.max(0, memo.counts.comments - 1))
        toast.add({ title: '已删除', variant: 'success' })
      }
    } catch {
      toast.add({ title: '删除失败', variant: 'error' })
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- session 可能为 null
  const viewerId = session?.user?.id

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="flex max-h-[min(80vh,42rem)] flex-col p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <Dialog.Title className="text-base font-semibold">评论</Dialog.Title>
          <Dialog.Close
            aria-label="关闭"
            render={(props) => (
              <Button
                {...props}
                variant="ghost"
                shape="square"
                size="xs"
                icon={<X size={16} />}
                aria-label="关闭"
              />
            )}
          />
        </div>

        {memo && (
          <div className="mb-4 rounded-lg bg-kumo-tint px-4 py-3 text-sm text-kumo-subtle">
            <span className="line-clamp-3 whitespace-pre-wrap">
              {memo.content}
            </span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {items.length === 0 && !loading ? (
            <p className="py-10 text-center text-sm text-kumo-subtle">
              还没有评论，来抢沙发。
            </p>
          ) : (
            <div className="grid gap-4">
              {items.map((comment) => (
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
                          onClick={() => void handleDelete(comment)}
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
          {loading && (
            <div className="flex justify-center py-4">
              <Loader size="sm" />
            </div>
          )}
          {hasMore && !loading && (
            <div className="py-3 text-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void load('next')}
              >
                加载更多
              </Button>
            </div>
          )}
        </div>

        <div className="mt-4 flex items-end gap-2 border-t border-kumo-line pt-3">
          <InputArea
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
                void handleSend()
              }
            }}
          />
          <Button
            variant="primary"
            shape="square"
            icon={<PaperPlaneRight size={15} />}
            loading={sending}
            disabled={!draft.trim()}
            onClick={() => void handleSend()}
            aria-label="发送评论"
          />
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
