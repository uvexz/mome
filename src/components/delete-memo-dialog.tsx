import { useEffect, useState } from 'react'
import { Button, Dialog } from '@cloudflare/kumo'
import { Trash, X } from '@phosphor-icons/react'

import type { MemoWithTags } from '#/server/memos'

interface DeleteMemoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  memo: MemoWithTags | null
  onConfirm: () => Promise<void> | void
}

/**
 * 删除二次确认对话框（open 属性控制，不做条件渲染）。
 */
export function DeleteMemoDialog({
  open,
  onOpenChange,
  memo,
  onConfirm,
}: DeleteMemoDialogProps) {
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (open) setDeleting(false)
  }, [open])

  async function handleConfirm() {
    if (deleting) return
    setDeleting(true)
    try {
      await onConfirm()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <Dialog.Title className="text-base font-semibold">
            删除这条 memo？
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
        <Dialog.Description className="text-sm text-kumo-subtle">
          删除后无法恢复。
          {memo && (
            <>
              <span className="mt-1 line-clamp-2 block text-kumo-default">
                “{memo.content.slice(0, 80)}
                {memo.content.length > 80 ? '…' : ''}”
              </span>
            </>
          )}
        </Dialog.Description>
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button variant="secondary" {...props}>
                取消
              </Button>
            )}
          />
          <Button
            variant="destructive"
            icon={<Trash size={14} />}
            loading={deleting}
            disabled={deleting}
            onClick={() => void handleConfirm()}
          >
            删除
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
