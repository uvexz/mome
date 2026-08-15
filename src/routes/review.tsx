import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Button, Loader, Select } from '@cloudflare/kumo'
import {
  ArrowClockwise,
  ArrowLeft,
  Quotes,
  Sparkle,
} from '@phosphor-icons/react'

import { HashtagText } from '#/components/hashtag-text'
import { relativeTime } from '#/lib/date'
import { tagsQueryOptions } from '#/lib/queries'
import { getReviewMemos } from '#/server/memos'
import type { MemoWithTags, ReviewMode } from '#/server/memos'
import { getSessionUser } from '#/server/session'
import type { TagWithCount } from '#/server/tags'

const MODES: Array<{ value: ReviewMode; label: string }> = [
  { value: 'least-reviewed', label: '较少回顾' },
  { value: 'on-this-day', label: '那年今日' },
  { value: 'random', label: '随机' },
]

export const Route = createFileRoute('/review')({
  beforeLoad: async () => {
    const user = await getSessionUser()
    if (!user) throw redirect({ to: '/login' })
  },
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(tagsQueryOptions()),
  component: Review,
})

function Review() {
  const navigate = useNavigate()
  const [items, setItems] = useState<MemoWithTags[] | null>(null)
  const { data: tags } = useSuspenseQuery(tagsQueryOptions())
  const [mode, setMode] = useState<ReviewMode>('least-reviewed')
  const [tag, setTag] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await getReviewMemos({
        data: {
          mode,
          n: 8,
          tag,
          tzOffsetMinutes: new Date().getTimezoneOffset(),
        },
      })
      setItems(result)
    } finally {
      setLoading(false)
    }
  }, [mode, tag])

  useEffect(() => {
    void load()
  }, [load])

  const tagItems = useMemo(() => buildTagItems(tags), [tags])

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
          <div className="flex items-center gap-2 text-sm font-semibold text-kumo-strong">
            <Sparkle size={16} weight="duotone" className="text-accent" />
            每日回顾
          </div>
          <div className="flex-1" />
          <Button
            variant="secondary"
            shape="square"
            icon={<ArrowClockwise size={15} />}
            loading={loading}
            aria-label="刷新回顾"
            title="刷新回顾"
            onClick={() => void load()}
          />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[640px] px-4 pb-24 pt-6">
        <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-kumo-tint p-0.5 text-sm">
            {MODES.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setMode(item.value)}
                className={
                  mode === item.value
                    ? 'rounded-md bg-kumo-base px-2 py-1.5 font-medium text-kumo-strong ring ring-kumo-line'
                    : 'rounded-md px-2 py-1.5 font-medium text-kumo-subtle hover:text-kumo-default'
                }
              >
                {item.label}
              </button>
            ))}
          </div>
          <Select
            aria-label="按标签回顾"
            size="sm"
            value={tag ?? 'all'}
            items={tagItems}
            onValueChange={(value) =>
              setTag(!value || value === 'all' ? undefined : value)
            }
          />
        </div>

        {items === null ? (
          <div className="flex justify-center py-16">
            <Loader />
          </div>
        ) : items.length === 0 ? (
          <p className="py-16 text-center text-sm text-kumo-subtle">
            当前范围内没有可回顾的 memo。
          </p>
        ) : (
          <div className="mt-6 grid gap-2">
            {items.map((memo) => (
              <article
                key={memo.id}
                className="rounded-lg bg-kumo-base px-5 py-4 ring ring-kumo-line"
              >
                <div className="text-sm leading-relaxed text-kumo-default">
                  <HashtagText content={memo.content} />
                </div>
                <div className="mt-2.5 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      void navigate({
                        to: '/memo/$memoId',
                        params: { memoId: memo.id },
                      })
                    }
                    className="font-mono text-xs text-kumo-subtle hover:text-accent"
                  >
                    <time dateTime={memo.createdAt}>
                      {relativeTime(memo.createdAt)}
                    </time>
                  </button>
                  <Button
                    variant="ghost"
                    shape="square"
                    size="xs"
                    icon={<Quotes size={14} />}
                    aria-label="引用到新 memo"
                    title="引用到新 memo"
                    onClick={() =>
                      void navigate({
                        to: '/capture',
                        search: { reference: memo.id },
                      })
                    }
                  />
                </div>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

function buildTagItems(tags: TagWithCount[]): Record<string, string> {
  const byId = new Map(tags.map((tag) => [tag.id, tag]))
  const items: Record<string, string> = { all: '全部标签' }
  for (const tag of tags) {
    const path = [tag.name]
    let parentId = tag.parentId
    while (parentId) {
      const parent = byId.get(parentId)
      if (!parent) break
      path.unshift(parent.name)
      parentId = parent.parentId
    }
    items[path.join('/')] = `#${path.join('/')} · ${tag.count}`
  }
  return items
}
