import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { Button, Loader, Text } from '@cloudflare/kumo'
import { ArrowLeft, Shuffle, Sparkle } from '@phosphor-icons/react'

import { HashtagText } from '#/components/hashtag-text'
import { getRandomMemos } from '#/server/memos'
import type { MemoWithTags } from '#/server/memos'
import { getSessionUser } from '#/server/session'
import { relativeTime } from '#/lib/date'

export const Route = createFileRoute('/review')({
  beforeLoad: async () => {
    const user = await getSessionUser()
    if (!user) throw redirect({ to: '/login' })
  },
  component: Review,
})

function Review() {
  const navigate = useNavigate()
  const [items, setItems] = useState<MemoWithTags[] | null>(null)
  const [loading, setLoading] = useState(false)

  const shuffle = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getRandomMemos({ data: { n: 8 } })
      setItems(res)
    } finally {
      setLoading(false)
    }
  }, [])

  // 首次进入自动抽一批
  useEffect(() => {
    if (items === null && !loading) void shuffle()
    // 仅在挂载时执行一次
  }, [])

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
            size="sm"
            icon={<Shuffle size={14} />}
            loading={loading}
            onClick={() => void shuffle()}
          >
            再来一批
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[640px] px-4 pb-24 pt-8">
        <Text variant="secondary" DANGEROUS_className="mb-6">
          随机翻出过往的碎片，让灵感再次相遇。
        </Text>

        {items === null ? (
          <div className="flex justify-center py-16">
            <Loader size="base" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-16 text-center text-sm text-kumo-subtle">
            还没有 memo，先去写一条吧。
          </p>
        ) : (
          <div className="grid gap-2">
            {items.map((memo) => (
              <article
                key={memo.id}
                className="rounded-xl bg-kumo-base px-5 py-4 ring ring-kumo-line"
              >
                <div className="text-sm leading-relaxed text-kumo-default">
                  <HashtagText content={memo.content} />
                </div>
                <time
                  dateTime={memo.createdAt}
                  className="mt-2.5 block font-mono text-xs text-kumo-subtle"
                >
                  {relativeTime(memo.createdAt)}
                </time>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
