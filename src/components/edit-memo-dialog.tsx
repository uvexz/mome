import { useEffect, useState } from 'react'
import { Button, Dialog, InputArea, Text } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'

import type { MemoWithTags } from '#/server/memos'

interface EditMemoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  memo: MemoWithTags | null
  onSave: (content: string) => Promise<void> | void
}

/**
 * 编辑 memo 对话框。用 `open` 属性控制显隐（不做条件渲染，
 * 以保证开关动画可用）。
 */
export function EditMemoDialog({
  open,
  onOpenChange,
  memo,
  onSave,
}: EditMemoDialogProps) {
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (memo) {
      setContent(memo.content)
      setError(null)
    }
  }, [memo])

  async function handleSave() {
    const text = content.trim()
    if (!text) return
    setSaving(true)
    setError(null)
    try {
      await onSave(text)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <Dialog.Title className="text-base font-semibold">
            编辑 memo
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
        <InputArea
          autoResize
          minRows={4}
          maxRows={14}
          aria-label="编辑 memo 内容"
          placeholder="编辑内容…"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="w-full px-4 text-sm"
        />
        <Text variant="secondary" size="sm" DANGEROUS_className="mt-2">
          <kbd className="font-mono text-[0.9em]">#标签</kbd>{' '}
          会被自动解析；保存后同步更新标签。
        </Text>
        {error && (
          <p role="alert" className="mt-2 text-sm text-kumo-danger">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button variant="secondary" {...props}>
                取消
              </Button>
            )}
          />
          <Button
            variant="primary"
            loading={saving}
            disabled={!content.trim()}
            onClick={() => void handleSave()}
          >
            保存
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
