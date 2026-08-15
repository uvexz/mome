import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Loader } from '@cloudflare/kumo'
import { ArrowLeft, Bell } from '@phosphor-icons/react'

import { Avatar } from '#/components/avatar'
import { relativeTime } from '#/lib/date'
import { notificationsQueryOptions, queryKeys } from '#/lib/queries'
import { markNotificationsRead } from '#/server/notifications'
import type { NotificationItem } from '#/server/notifications'
import { getSessionUser } from '#/server/session'

const ACTION_LABEL: Record<NotificationItem['type'], string> = {
  like: '赞了你的 memo',
  comment: '回复了你的 memo',
  repost: '转发了你的 memo',
}

export const Route = createFileRoute('/notifications')({
  beforeLoad: async () => {
    const user = await getSessionUser()
    if (!user) throw redirect({ to: '/login' })
  },
  loader: ({ context }) =>
    context.queryClient.ensureInfiniteQueryData(notificationsQueryOptions()),
  component: NotificationsPage,
})

function NotificationsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const query = useInfiniteQuery(notificationsQueryOptions())
  const items = query.data?.pages.flatMap((page) => page.items) ?? []

  useEffect(() => {
    queryClient.setQueryData([...queryKeys.notifications, 'unread'], {
      count: 0,
    })
    void markNotificationsRead({ data: { all: true } })
  }, [queryClient])

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
            <Bell size={16} weight="duotone" className="text-accent" />
            通知
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[640px] px-4 pb-24 pt-6">
        {query.isPending ? (
          <div className="flex justify-center py-16">
            <Loader />
          </div>
        ) : items.length === 0 ? (
          <p className="py-16 text-center text-sm text-kumo-subtle">
            还没有收到互动。
          </p>
        ) : (
          <div className="divide-y divide-kumo-line">
            {items.map((item) => (
              <article key={item.id} className="flex gap-3 px-1 py-4">
                <Avatar
                  image={item.actor.image}
                  size={32}
                  className="shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-sm">
                    <span className="font-medium text-kumo-strong">
                      {item.actor.name}
                    </span>
                    <span className="font-mono text-xs text-kumo-subtle">
                      @{item.actor.username}
                    </span>
                    <span className="text-kumo-default">
                      {ACTION_LABEL[item.type]}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="mt-1.5 line-clamp-2 text-left text-sm text-kumo-subtle hover:text-kumo-default"
                    onClick={() =>
                      void navigate({
                        to: '/memo/$memoId',
                        params: { memoId: item.memo.id },
                      })
                    }
                  >
                    {item.memo.content}
                  </button>
                  <time
                    dateTime={item.createdAt}
                    className="mt-1.5 block font-mono text-xs text-kumo-subtle"
                  >
                    {relativeTime(item.createdAt)}
                  </time>
                </div>
              </article>
            ))}
          </div>
        )}

        {query.hasNextPage && (
          <div className="mt-6 flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              加载更多
            </Button>
          </div>
        )}
      </main>
    </div>
  )
}
