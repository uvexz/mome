import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Dialog,
  InputArea,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { ArrowBendUpRight, X } from '@phosphor-icons/react'

import { queryKeys } from '#/lib/queries'
import { toggleRepost, updateRepost } from '#/server/interactions'
import type { MemoCounts } from '#/server/interactions-core'
import type { MemoWithTags } from '#/server/memos'

interface RepostDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  memo: MemoWithTags | null
  onReposted: (
    counts: MemoCounts,
    reposted: boolean,
    content: string | null,
  ) => void
}

/**
 * 转发对话框：可选附言；已转发时可更新附言或取消转发。
 */
export function RepostDialog({
  open,
  onOpenChange,
  memo,
  onReposted,
}: RepostDialogProps) {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const reposted = memo?.viewerState.reposted ?? false

  useEffect(() => {
    if (open && memo) {
      setContent(memo.viewerState.repostedContent ?? '')
    }
  }, [open, memo])

  async function submit(action: 'create' | 'update' | 'remove') {
    if (!memo || submitting) return
    setSubmitting(true)
    try {
      if (action === 'remove') {
        const res = await toggleRepost({ data: { memoId: memo.id } })
        onReposted(res.counts, false, null)
        toast.add({ title: '已取消转发', variant: 'success' })
      } else {
        const res =
          action === 'create'
            ? await toggleRepost({
                data: { memoId: memo.id, content: content.trim() || undefined },
              })
            : await updateRepost({
                data: { memoId: memo.id, content: content.trim() || undefined },
              })
        onReposted(res.counts, true, content.trim() || null)
        toast.add({ title: '已转发', variant: 'success' })
      }
      for (const queryKey of [
        queryKeys.memos,
        queryKeys.public,
        queryKeys.interactions,
      ]) {
        void queryClient.invalidateQueries({ queryKey, refetchType: 'none' })
      }
      onOpenChange(false)
    } catch (err) {
      toast.add({
        title: '操作失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <Dialog.Title className="text-base font-semibold">
            转发 memo
          </Dialog.Title>
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

        <InputArea
          autoResize
          minRows={2}
          maxRows={8}
          placeholder={reposted ? '更新转发附言…' : '说点什么（可选）…'}
          aria-label="转发附言"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="w-full px-4 text-sm"
        />
        <Text variant="secondary" size="sm" DANGEROUS_className="mt-2">
          转发后会在你的时间线和公开主页展示。
        </Text>

        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button variant="secondary" {...props}>
                取消
              </Button>
            )}
          />
          {reposted ? (
            <>
              <Button
                variant="ghost"
                loading={submitting}
                onClick={() => void submit('remove')}
              >
                取消转发
              </Button>
              <Button
                variant="primary"
                icon={<ArrowBendUpRight size={14} />}
                loading={submitting}
                onClick={() => void submit('update')}
              >
                更新转发
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              icon={<ArrowBendUpRight size={14} />}
              loading={submitting}
              onClick={() => void submit('create')}
            >
              转发
            </Button>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
