import { useEffect, useRef, useState } from 'react'
import { Button, InputArea } from '@cloudflare/kumo'
import {
  ArrowUpRight,
  GlobeSimple,
  ImageSquare,
  LockSimple,
} from '@phosphor-icons/react'

import { cn } from '#/lib/utils'
import { authClient } from '#/lib/auth-client'
import {
  clearComposerDraft,
  enqueueMemo,
  listQueuedMemos,
  loadComposerDraft,
  removeQueuedMemo,
  saveComposerDraft,
} from '#/lib/composer-storage'
import { uploadPresignedPost } from '#/lib/upload'
import { getAppConfig } from '#/server/config'
import { createMemo } from '#/server/memos'
import type { MemoWithTags } from '#/server/memos'
import { getUploadUrl } from '#/server/upload'

function isBrowserOnline(): boolean {
  return navigator.onLine
}

interface ComposerProps {
  onCreated: (memo: MemoWithTags) => void
  onError: (message: string) => void
  onQueued?: () => void
  initialContent?: string
  initialVisibility?: 'public' | 'private'
  draftScope?: string
}

/**
 * 快速输入框：多行自适应、⌘/Ctrl+Enter 提交、
 * 发布前选择可见性，支持插入图片（S3 或 base64 回退）。
 */
export function Composer({
  onCreated,
  onError,
  onQueued,
  initialContent = '',
  initialVisibility,
  draftScope = 'home',
}: ComposerProps) {
  const { data: session } = authClient.useSession()
  const [content, setContent] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'private'>('private')
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [s3Enabled, setS3Enabled] = useState(false)
  const [draftStatus, setDraftStatus] = useState<
    'idle' | 'saving' | 'saved' | 'queued'
  >('idle')
  const contentRef = useRef('')
  const fileRef = useRef<HTMLInputElement>(null)
  const initializedRef = useRef(false)
  const draftKeyRef = useRef<string | null>(null)
  const onCreatedRef = useRef(onCreated)
  const onErrorRef = useRef(onError)
  onCreatedRef.current = onCreated
  onErrorRef.current = onError
  contentRef.current = content

  useEffect(() => {
    const userId = session?.user.id
    if (!userId) return
    const key = `${userId}:${draftScope}`
    draftKeyRef.current = key
    let cancelled = false

    void Promise.all([
      getAppConfig().catch(() => null),
      loadComposerDraft(key).catch(() => null),
    ]).then(([config, draft]) => {
      if (cancelled) return
      setS3Enabled(config?.s3Enabled ?? false)
      setContent(initialContent.trim() || draft?.content || '')
      setVisibility(
        initialVisibility ??
          draft?.visibility ??
          config?.defaultVisibility ??
          'private',
      )
      initializedRef.current = true
      if (draft?.content && !initialContent.trim()) setDraftStatus('saved')
    })

    return () => {
      cancelled = true
    }
  }, [draftScope, initialContent, initialVisibility, session?.user.id])

  useEffect(() => {
    const key = draftKeyRef.current
    if (!key || !initializedRef.current) return
    setDraftStatus('saving')
    const timer = window.setTimeout(() => {
      const operation = content.trim()
        ? saveComposerDraft(key, {
            content,
            visibility,
            updatedAt: Date.now(),
          })
        : clearComposerDraft(key)
      void operation
        .then(() => setDraftStatus(content.trim() ? 'saved' : 'idle'))
        .catch(() => setDraftStatus('idle'))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [content, visibility])

  useEffect(() => {
    let flushing = false
    async function flushOutbox() {
      if (flushing || !isBrowserOnline()) return
      flushing = true
      try {
        const queued = await listQueuedMemos()
        for (const item of queued) {
          try {
            const memo = await createMemo({
              data: {
                content: item.content,
                visibility: item.visibility,
                clientId: item.id,
              },
            })
            await removeQueuedMemo(item.id)
            if (!memo.deletedAt) onCreatedRef.current(memo)
          } catch (error) {
            if (!isBrowserOnline()) break
            onErrorRef.current(
              error instanceof Error ? error.message : '离线内容发送失败',
            )
            break
          }
        }
      } finally {
        flushing = false
      }
    }

    void flushOutbox()
    window.addEventListener('online', flushOutbox)
    return () => window.removeEventListener('online', flushOutbox)
  }, [])

  async function submit() {
    const text = content.trim()
    if (!text || submitting) return
    const clientId = crypto.randomUUID()
    setSubmitting(true)
    try {
      if (!navigator.onLine) {
        await enqueueMemo({
          id: clientId,
          content: text,
          visibility,
          createdAt: Date.now(),
        })
        setContent('')
        setDraftStatus('queued')
        if (draftKeyRef.current) {
          await clearComposerDraft(draftKeyRef.current)
        }
        onQueued?.()
        return
      }

      const memo = await createMemo({
        data: { content: text, visibility, clientId },
      })
      setContent('')
      setDraftStatus('idle')
      if (draftKeyRef.current) {
        await clearComposerDraft(draftKeyRef.current)
      }
      if (!memo.deletedAt) onCreated(memo)
    } catch (err) {
      if (!navigator.onLine) {
        await enqueueMemo({
          id: clientId,
          content: text,
          visibility,
          createdAt: Date.now(),
        })
        setContent('')
        setDraftStatus('queued')
        onQueued?.()
      } else {
        onError(err instanceof Error ? err.message : '发布失败，请重试')
      }
    } finally {
      setSubmitting(false)
    }
  }

  function insertAtCursor(text: string) {
    const ta = document.getElementById(
      'memo-composer-input',
    ) as HTMLTextAreaElement | null
    const current = contentRef.current
    if (ta) {
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const next = current.slice(0, start) + text + current.slice(end)
      setContent(next)
      requestAnimationFrame(() => {
        ta.focus()
        const pos = start + text.length
        ta.setSelectionRange(pos, pos)
      })
    } else {
      setContent(current ? `${current}\n${text}` : text)
    }
  }

  async function uploadImage(file: File | undefined) {
    if (!file) return
    setUploading(true)
    try {
      const ext = (file.name.split('.').pop() ?? 'jpg').toLowerCase()
      const upload = await getUploadUrl({ data: { kind: 'memo-image', ext } })
      let markdown: string
      if (upload.mode === 'presigned') {
        await uploadPresignedPost(upload, file)
        markdown = `![image](${upload.publicUrl})`
      } else {
        markdown = `![image](${await fileToDataUrl(file)})`
      }
      insertAtCursor(markdown)
    } catch (err) {
      onError(err instanceof Error ? err.message : '图片上传失败，请重试')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="rounded-xl bg-kumo-base px-4 py-3 ring ring-kumo-line focus-within:ring-kumo-brand">
      <InputArea
        id="memo-composer-input"
        autoResize
        minRows={2}
        maxRows={12}
        placeholder="写下此刻的想法… 用 #标签 归类"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={submitting}
        className="w-full resize-none rounded-none border-none bg-transparent p-0 text-sm shadow-none ring-0 focus:ring-0"
        aria-label="新 memo"
      />
      <div className="mt-1 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-0.5 rounded-lg bg-kumo-tint p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setVisibility('public')}
              aria-pressed={visibility === 'public'}
              className={cn(
                'flex h-8 items-center gap-1 rounded-md px-2.5 font-medium',
                visibility === 'public'
                  ? 'bg-kumo-base text-accent ring ring-kumo-line'
                  : 'text-kumo-subtle hover:text-kumo-default',
              )}
            >
              <GlobeSimple size={12} weight="fill" />
              公开
            </button>
            <button
              type="button"
              onClick={() => setVisibility('private')}
              aria-pressed={visibility === 'private'}
              className={cn(
                'flex h-8 items-center gap-1 rounded-md px-2.5 font-medium',
                visibility === 'private'
                  ? 'bg-kumo-base text-kumo-strong ring ring-kumo-line'
                  : 'text-kumo-subtle hover:text-kumo-default',
              )}
            >
              <LockSimple size={12} weight="fill" />
              仅自己可见
            </button>
          </div>
          {s3Enabled && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void uploadImage(e.target.files?.[0])}
                aria-label="上传图片到 memo"
              />
              <Button
                variant="ghost"
                shape="square"
                size="sm"
                icon={<ImageSquare size={15} />}
                loading={uploading}
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
                aria-label="插入图片"
                title="插入图片"
                className="h-8 w-8"
              />
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden font-mono text-xs text-kumo-subtle sm:inline">
            {draftStatus === 'saving' && '保存中'}
            {draftStatus === 'saved' && '草稿已保存'}
            {draftStatus === 'queued' && '已加入待发送'}
          </span>
          <Button
            size="sm"
            variant="primary"
            icon={<ArrowUpRight size={14} />}
            loading={submitting}
            disabled={!content.trim()}
            onClick={() => void submit()}
            className="h-8"
          >
            发送
          </Button>
        </div>
      </div>
    </div>
  )
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('read file failed'))
    reader.readAsDataURL(file)
  })
}
