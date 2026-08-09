import {
  createFileRoute,
  redirect,
  useLoaderData,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, Loader, useKumoToastManager } from '@cloudflare/kumo'
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ClockCounterClockwise,
  Quotes,
  X,
} from '@phosphor-icons/react'

import { HashtagText } from '#/components/hashtag-text'
import { relativeTime } from '#/lib/date'
import {
  getMemoDetail,
  listMemoVersions,
  restoreMemoVersion,
} from '#/server/memos'
import type {
  MemoConnections,
  MemoVersionItem,
  MemoWithTags,
} from '#/server/memos'
import { getSessionUser } from '#/server/session'

export const Route = createFileRoute('/memo/$memoId')({
  beforeLoad: async () => {
    const user = await getSessionUser()
    if (!user) throw redirect({ to: '/login' })
  },
  loader: ({ params }) => getMemoDetail({ data: { id: params.memoId } }),
  component: MemoDetailPage,
})

function MemoDetailPage() {
  const loaderData = useLoaderData({ from: '/memo/$memoId' })
  const [memo, setMemo] = useState(loaderData.memo)
  const [historyOpen, setHistoryOpen] = useState(false)
  const navigate = useNavigate()
  const router = useRouter()
  const toast = useKumoToastManager()

  useEffect(() => setMemo(loaderData.memo), [loaderData.memo])

  async function handleRestoreVersion(versionId: string) {
    const restored = await restoreMemoVersion({
      data: { memoId: memo.id, versionId },
    })
    setMemo(restored)
    setHistoryOpen(false)
    await router.invalidate()
    toast.add({ title: '已恢复历史版本', variant: 'success' })
  }

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
            onClick={() => history.back()}
          />
          <div className="text-sm font-semibold text-kumo-strong">Memo</div>
          <div className="flex-1" />
          <Button
            variant="secondary"
            size="sm"
            icon={<ClockCounterClockwise size={14} />}
            onClick={() => setHistoryOpen(true)}
          >
            历史
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Quotes size={14} />}
            onClick={() =>
              void navigate({
                to: '/capture',
                search: { reference: memo.id },
              })
            }
          >
            引用
          </Button>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[640px] gap-8 px-4 pb-24 pt-8">
        <article className="rounded-lg bg-kumo-base px-5 py-4 ring ring-kumo-line">
          <div className="text-sm leading-relaxed text-kumo-default">
            <HashtagText content={memo.content} />
          </div>
          <div className="mt-3 flex items-center gap-2 font-mono text-xs text-kumo-subtle">
            <span>{memo.visibility === 'public' ? '公开' : '仅自己可见'}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={memo.createdAt}>
              {relativeTime(memo.createdAt)}
            </time>
          </div>
        </article>

        <ConnectionSection
          title="引用的 memo"
          items={loaderData.connections.outgoing}
        />
        <ConnectionSection
          title="引用了这条"
          items={loaderData.connections.backlinks}
        />
        <ConnectionSection
          title="相关 memo"
          items={loaderData.connections.related}
        />
      </main>

      <VersionHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        memoId={memo.id}
        onRestore={handleRestoreVersion}
      />
    </div>
  )
}

function VersionHistoryDialog({
  open,
  onOpenChange,
  memoId,
  onRestore,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  memoId: string
  onRestore: (versionId: string) => Promise<void>
}) {
  const toast = useKumoToastManager()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const [versions, setVersions] = useState<MemoVersionItem[]>([])
  const [loading, setLoading] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setRestoringId(null)
    void listMemoVersions({ data: { memoId } })
      .then((items) => {
        if (active) setVersions(items)
      })
      .catch((error: unknown) => {
        if (!active) return
        toastRef.current.add({
          title: '历史记录加载失败',
          description: error instanceof Error ? error.message : '请稍后重试',
          variant: 'error',
        })
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [memoId, open])

  async function handleRestore(versionId: string) {
    if (restoringId) return
    setRestoringId(versionId)
    try {
      await onRestore(versionId)
    } catch (error) {
      toast.add({
        title: '恢复失败',
        description: error instanceof Error ? error.message : '请稍后重试',
        variant: 'error',
      })
    } finally {
      setRestoringId(null)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <Dialog.Title className="text-base font-semibold">
              版本历史
            </Dialog.Title>
            <Dialog.Description className="text-sm text-kumo-subtle">
              每次编辑前会保存一个快照，最多显示最近 50 个版本。
            </Dialog.Description>
          </div>
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

        <div className="max-h-[60dvh] overflow-y-auto border-t border-kumo-line">
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader size="sm" />
            </div>
          ) : versions.length === 0 ? (
            <p className="py-10 text-center text-sm text-kumo-subtle">
              还没有历史版本
            </p>
          ) : (
            <div className="divide-y divide-kumo-line">
              {versions.map((version) => (
                <article key={version.id} className="grid gap-3 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <time
                      dateTime={version.createdAt}
                      className="font-mono text-xs text-kumo-subtle"
                    >
                      {new Date(version.createdAt).toLocaleString()}
                    </time>
                    <Button
                      variant="secondary"
                      size="xs"
                      icon={<ArrowCounterClockwise size={13} />}
                      loading={restoringId === version.id}
                      disabled={Boolean(restoringId)}
                      onClick={() => void handleRestore(version.id)}
                    >
                      恢复此版本
                    </Button>
                  </div>
                  <p className="line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed text-kumo-default">
                    {version.content}
                  </p>
                </article>
              ))}
            </div>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  )
}

function ConnectionSection({
  title,
  items,
}: {
  title: string
  items: MemoConnections['related']
}) {
  const navigate = useNavigate()
  if (items.length === 0) return null
  return (
    <section className="grid gap-3">
      <h2 className="text-sm font-semibold text-kumo-strong">{title}</h2>
      <div className="divide-y divide-kumo-line">
        {items.map((item: MemoWithTags) => (
          <button
            key={item.id}
            type="button"
            className="block w-full px-1 py-3 text-left hover:bg-kumo-tint"
            onClick={() =>
              void navigate({
                to: '/memo/$memoId',
                params: { memoId: item.id },
              })
            }
          >
            <span className="line-clamp-2 text-sm leading-relaxed text-kumo-default">
              {item.content}
            </span>
            <time
              dateTime={item.createdAt}
              className="mt-1 block font-mono text-xs text-kumo-subtle"
            >
              {relativeTime(item.createdAt)}
            </time>
          </button>
        ))}
      </div>
    </section>
  )
}
