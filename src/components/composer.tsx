import { useEffect, useRef, useState } from 'react'
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Button, InputArea } from '@cloudflare/kumo'
import {
  ArrowUpRight,
  GlobeSimple,
  ImageSquare,
  LockSimple,
  Paperclip,
} from '@phosphor-icons/react'

import { cn } from '#/lib/utils'
import { authClient } from '#/lib/auth-client'
import { appConfigQueryOptions, queryKeys } from '#/lib/queries'
import {
  clearComposerDraft,
  countUnclaimedQueuedMemos,
  enqueueMemo,
  incrementQueuedMemoAttempts,
  listQueuedMemos,
  loadComposerDraft,
  removeQueuedMemo,
  saveComposerDraft,
} from '#/lib/composer-storage'
import { MAX_CONTENT } from '#/lib/limits'
import { resolveImageUpload, uploadPresignedPost } from '#/lib/upload'
import { createMemo } from '#/server/memos'
import type { MemoWithTags } from '#/server/memos'
import { getUploadUrl } from '#/server/upload'

/** 在线重发同一离线条目连续失败该次数后，停止重试但保留内容 */
const MAX_OUTBOX_ATTEMPTS = 3

// 模块级 flush 锁：多个 Composer 实例 / StrictMode 双挂载也不会并发重发同一个 outbox
let flushingOutbox = false

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
  const queryClient = useQueryClient()
  const { data: config } = useSuspenseQuery(appConfigQueryOptions())
  const { data: session } = authClient.useSession()
  const [content, setContent] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'private'>('private')
  const [submitting, setSubmitting] = useState(false)
  const [fileUploading, setFileUploading] = useState(false)
  const [pasteUploads, setPasteUploads] = useState(0)
  const [insertedImages, setInsertedImages] = useState(0)
  const [draftStatus, setDraftStatus] = useState<
    'idle' | 'saving' | 'saved' | 'queued'
  >('idle')
  const contentRef = useRef('')
  const visibilityRef = useRef<'public' | 'private'>('private')
  const fileRef = useRef<HTMLInputElement>(null)
  const initializedRef = useRef(false)
  const draftKeyRef = useRef<string | null>(null)
  const onCreatedRef = useRef(onCreated)
  const onErrorRef = useRef(onError)
  onCreatedRef.current = onCreated
  onErrorRef.current = onError
  contentRef.current = content
  visibilityRef.current = visibility
  const userId = session?.user.id ?? null
  const busy = fileUploading || pasteUploads > 0

  useEffect(() => {
    if (!userId) return
    const key = `${userId}:${draftScope}`
    draftKeyRef.current = key
    let cancelled = false

    void loadComposerDraft(key)
      .catch(() => null)
      .then((draft) => {
        if (cancelled) return
        // 加载期间用户已经开始输入时，不要用草稿覆盖
        if (!contentRef.current) {
          setContent(initialContent.trim() || draft?.content || '')
        }
        setVisibility(
          initialVisibility ?? draft?.visibility ?? config.defaultVisibility,
        )
        initializedRef.current = true
        if (draft?.content && !initialContent.trim()) setDraftStatus('saved')
      })

    return () => {
      cancelled = true
    }
  }, [
    config.defaultVisibility,
    draftScope,
    initialContent,
    initialVisibility,
    userId,
  ])

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

  // 卸载/跳转时补写一次未落盘的防抖草稿
  useEffect(() => {
    return () => {
      const key = draftKeyRef.current
      if (!key || !initializedRef.current || !contentRef.current.trim()) return
      void saveComposerDraft(key, {
        content: contentRef.current,
        visibility: visibilityRef.current,
        updatedAt: Date.now(),
      }).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    if (!userId) return
    async function flushOutbox() {
      if (flushingOutbox || !isBrowserOnline() || !userId) return
      flushingOutbox = true
      try {
        const queued = await listQueuedMemos(userId)
        for (const item of queued) {
          // 已达重试上限：跳过而不删除，内容留在 outbox 里等人工处理
          if ((item.attempts ?? 0) >= MAX_OUTBOX_ATTEMPTS) continue
          try {
            const memo = await createMemo({
              data: {
                content: item.content,
                visibility: item.visibility,
                clientId: item.id,
              },
            })
            await removeQueuedMemo(item.id)
            if (!memo.deletedAt) {
              void queryClient.invalidateQueries({
                queryKey: queryKeys.memos,
                refetchType: 'none',
              })
              onCreatedRef.current(memo)
            }
          } catch (error) {
            if (!isBrowserOnline()) break
            // 在线状态下的失败：可能是服务端校验拒绝（永远不会成功），
            // 也可能是瞬时故障——用失败计数区分，超限后停止重试但保留原文
            const attempts = await incrementQueuedMemoAttempts(item.id)
            if (attempts >= MAX_OUTBOX_ATTEMPTS) {
              onErrorRef.current(
                `离线内容连续 ${attempts} 次发送失败，已停止重试；内容仍保留在待发送队列中`,
              )
            } else {
              onErrorRef.current(
                error instanceof Error ? error.message : '离线内容发送失败',
              )
            }
            break
          }
        }
      } finally {
        flushingOutbox = false
      }
    }

    void flushOutbox()
    window.addEventListener('online', flushOutbox)
    return () => window.removeEventListener('online', flushOutbox)
  }, [queryClient, userId])

  // 旧版本（无作者字段）或其他账号留下的待发送内容：提示而不是替他们发送
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void countUnclaimedQueuedMemos(userId)
      .then((count) => {
        if (cancelled || count === 0) return
        onErrorRef.current(
          `本浏览器还有 ${count} 条其他账号的待发送内容，已隔离不会自动发送`,
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [userId])

  // 同账号多个标签共用一个 draft key：只清掉与本次发送一致的草稿，
  // 避免删掉另一个标签正在编辑的内容
  async function clearDraftIfMatches(key: string, text: string) {
    const draft = await loadComposerDraft(key).catch(() => null)
    if (!draft || draft.content.trim() === text) await clearComposerDraft(key)
  }

  async function submit() {
    const text = content.trim()
    if (!text || submitting) return
    if (busy) {
      onError('图片上传中，请等待上传完成后再发送')
      return
    }
    if (text.length > MAX_CONTENT) {
      onError(`内容超过 ${MAX_CONTENT} 字上限，请拆分后再发布`)
      return
    }
    if (!userId) {
      onError('登录状态已失效，请重新登录后再发送')
      return
    }
    const clientId = crypto.randomUUID()
    setSubmitting(true)
    try {
      if (!navigator.onLine) {
        await enqueueMemo({
          id: clientId,
          userId,
          content: text,
          visibility,
          createdAt: Date.now(),
        })
        setContent('')
        setDraftStatus('queued')
        if (draftKeyRef.current) {
          await clearDraftIfMatches(draftKeyRef.current, text)
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
        await clearDraftIfMatches(draftKeyRef.current, text)
      }
      if (!memo.deletedAt) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.memos,
          refetchType: 'none',
        })
        onCreated(memo)
      }
    } catch (err) {
      if (!navigator.onLine) {
        await enqueueMemo({
          id: clientId,
          userId,
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

  /**
   * 在光标处插入文本。`caret` 为 null 表示"按当前光标插入"，
   * 为数字表示粘贴那一刻记下的位置；上传期间内容被改过时由调用方传 undefined 退回末尾。
   */
  function insertAtCursor(text: string, caret?: number | null): number {
    const ta = document.getElementById(
      'memo-composer-input',
    ) as HTMLTextAreaElement | null
    const current = contentRef.current
    if (ta) {
      const start =
        caret == null ? ta.selectionStart : Math.min(caret, current.length)
      const end = caret == null ? ta.selectionEnd : start
      const next = current.slice(0, start) + text + current.slice(end)
      contentRef.current = next
      setContent(next)
      const pos = start + text.length
      requestAnimationFrame(() => {
        ta.focus()
        ta.setSelectionRange(pos, pos)
      })
      return pos
    }
    const next = current ? `${current}\n${text}` : text
    contentRef.current = next
    setContent(next)
    return next.length
  }

  /** 取一个预签名 URL 并上传，返回可直接插入正文的 Markdown 图片链接 */
  async function uploadToMarkdown(file: File): Promise<string> {
    // 剪贴板里的文件往往没有可信的文件名 / 类型，扩展名以文件头魔数为准
    const { ext } = await resolveImageUpload(file)
    const upload = await getUploadUrl({ data: { kind: 'memo-image', ext } })
    if (upload.mode !== 'presigned') {
      throw new Error('S3 未配置，图片上传不可用')
    }
    await uploadPresignedPost(upload, file)
    return `![image](${upload.publicUrl})`
  }

  async function uploadImage(file: File | undefined) {
    if (!file) return
    setFileUploading(true)
    try {
      insertAtCursor(await uploadToMarkdown(file))
    } catch (err) {
      onError(err instanceof Error ? err.message : '图片上传失败，请重试')
    } finally {
      setFileUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  /**
   * 粘贴图片即上传：命中剪贴板文件时接管默认粘贴（否则文件名会被当正文插进输入框），
   * 上传完成后在粘贴位置写入 Markdown 链接。
   */
  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    // React 的合成事件类型把 clipboardData 标成非空，但旧浏览器上可能是 null
    const clipboard = e.clipboardData as DataTransfer | null
    const files = Array.from(clipboard?.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    // 没有文件（纯文本）交给浏览器默认行为
    if (!files.length) return
    // 富文本选区里同时带着文字和图片（网页 / 表格）：上传图片会把同批文字丢掉，不如原样粘贴
    const hasText = Array.from(clipboard?.items ?? []).some(
      (item) => item.kind === 'string' && item.type === 'text/plain',
    )
    if (hasText) return
    e.preventDefault()

    const ta = e.currentTarget
    // 粘贴时的插入位置，上传结束后可能已失效（见下）
    let caret: number | null | undefined = ta.selectionStart
    const snapshot = contentRef.current
    const failed: string[] = []
    setPasteUploads((n) => n + files.length)
    try {
      for (const file of files) {
        // 上一个 await 期间用户可能改过正文：位置失效就交回当前光标，不写错地方
        if (contentRef.current !== snapshot) caret = undefined
        try {
          const md = await uploadToMarkdown(file)
          caret = insertAtCursor(md, caret)
        } catch (err) {
          failed.push(err instanceof Error ? err.message : '图片上传失败')
        } finally {
          setPasteUploads((n) => n - 1)
        }
      }
      setInsertedImages(files.length - failed.length)
      if (failed.length) {
        onError(
          failed.length === files.length
            ? failed[0]
            : `${failed.length} 张图片上传失败：${failed[0]}`,
        )
      }
    } finally {
      setPasteUploads(0)
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
        onPaste={(e) => void onPaste(e)}
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
          {config.s3Enabled && (
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
                loading={fileUploading}
                disabled={busy}
                onClick={() => fileRef.current?.click()}
                aria-label="插入图片"
                title="插入图片，也可直接粘贴图片"
                className="h-8 w-8"
              />
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 font-mono text-xs text-kumo-subtle">
            {busy && (
              <>
                <Paperclip size={12} />
                上传中…
              </>
            )}
            {!busy && (
              <span className="hidden sm:inline">
                {draftStatus === 'saving' && '保存中'}
                {draftStatus === 'saved' && '草稿已保存'}
                {draftStatus === 'queued' && '已加入待发送'}
              </span>
            )}
          </span>
          <span className="sr-only" aria-live="polite">
            {insertedImages > 0 && !busy && `${insertedImages} 张图片已上传`}
          </span>
          <Button
            size="sm"
            variant="primary"
            icon={<ArrowUpRight size={14} />}
            loading={submitting}
            disabled={!content.trim() || busy}
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
