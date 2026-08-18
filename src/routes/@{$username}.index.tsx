import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import {
  useQueryClient,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { Button, Loader, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowLeft } from '@phosphor-icons/react'

import { authClient } from '#/lib/auth-client'
import { Avatar } from '#/components/avatar'
import { MemoCard } from '#/components/memo-card'
import { MemoCommentsDialog } from '#/components/memo-comments-dialog'
import { RepostDialog } from '#/components/repost-dialog'
import {
  mapInfiniteItems,
  publicMemosQueryOptions,
  publicProfileQueryOptions,
  queryKeys,
} from '#/lib/queries'
import { toggleFavorite, toggleLike } from '#/server/interactions'
import type { MemoCounts } from '#/server/interactions-core'
import type { PublicProfile } from '#/server/public-core'
import type { MemoWithTags } from '#/server/memos'

export const Route = createFileRoute('/@{$username}/')({
  loader: async ({ context, params }) => {
    const username = params.username.toLowerCase()
    const profile = await context.queryClient.ensureQueryData(
      publicProfileQueryOptions(username),
    )
    if (!profile) throw notFound()
    await context.queryClient.ensureInfiniteQueryData(
      publicMemosQueryOptions(profile.username),
    )
  },
  component: ProfilePage,
})

function ProfilePage() {
  const username = Route.useParams().username.toLowerCase()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const { data: session } = authClient.useSession()
  const { data: profile } = useSuspenseQuery(
    publicProfileQueryOptions(username),
  )
  const memosOptions = publicMemosQueryOptions(username)
  const memos = useSuspenseInfiniteQuery(memosOptions)
  if (!profile) throw notFound()
  const items = memos.data.pages.flatMap((page) => page.items)
  const [commenting, setCommenting] = useState<MemoWithTags | null>(null)
  const [commentOpen, setCommentOpen] = useState(false)
  const [reposting, setReposting] = useState<MemoWithTags | null>(null)
  const [repostOpen, setRepostOpen] = useState(false)
  function requireLogin(): boolean {
    if (session?.user) return true
    void navigate({ to: '/login' })
    return false
  }

  function patchItem(id: string, patch: Partial<MemoWithTags>) {
    queryClient.setQueryData(memosOptions.queryKey, (data) =>
      mapInfiniteItems(data, (item) =>
        item.memo.id === id
          ? { ...item, memo: { ...item.memo, ...patch } }
          : item,
      ),
    )
  }

  function markRelatedQueriesStale() {
    for (const queryKey of [
      queryKeys.memos,
      queryKeys.public,
      queryKeys.interactions,
    ]) {
      void queryClient.invalidateQueries({ queryKey, refetchType: 'none' })
    }
  }

  async function handleLike(memo: MemoWithTags) {
    if (!requireLogin()) return
    try {
      const res = await toggleLike({ data: { memoId: memo.id } })
      patchItem(memo.id, {
        counts: res.counts,
        viewerState: { ...memo.viewerState, liked: res.liked },
      })
      markRelatedQueriesStale()
    } catch (err) {
      toast.add({
        title: '点赞失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    }
  }

  async function handleFavorite(memo: MemoWithTags) {
    if (!requireLogin()) return
    try {
      const res = await toggleFavorite({ data: { memoId: memo.id } })
      patchItem(memo.id, {
        counts: res.counts,
        viewerState: { ...memo.viewerState, favorited: res.favorited },
      })
      markRelatedQueriesStale()
    } catch (err) {
      toast.add({
        title: '收藏失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    }
  }

  function handleComment(memo: MemoWithTags) {
    if (!requireLogin()) return
    setCommenting(memo)
    setCommentOpen(true)
  }

  function handleRepost(memo: MemoWithTags) {
    if (!requireLogin()) return
    setReposting(memo)
    setRepostOpen(true)
  }

  function handleReposted(
    memo: MemoWithTags,
    counts: MemoCounts,
    reposted: boolean,
    content: string | null,
  ) {
    patchItem(memo.id, {
      counts,
      viewerState: {
        ...memo.viewerState,
        reposted,
        repostedContent: content,
      },
    })
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
            onClick={() => void navigate({ to: '/' })}
          />
          <div className="flex items-center gap-2 text-sm font-semibold text-kumo-strong">
            {profile.name}
          </div>
          <span className="font-mono text-xs text-kumo-subtle">
            @{profile.username}
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[640px] px-4 pb-24 pt-8">
        <ProfileHeader profile={profile} />

        {items.length === 0 ? (
          <p className="py-16 text-center text-sm text-kumo-subtle">
            还没有公开 memo。
          </p>
        ) : (
          <div className="mt-6 grid gap-2">
            {items.map((item) => (
              <MemoCard
                key={`${item.kind}-${item.memo.id}`}
                memo={item.memo}
                profileUsername={profile.username}
                author={item.author}
                repost={item.repost}
                hideVisibility
                onLike={(m) => void handleLike(m)}
                onFavorite={(m) => void handleFavorite(m)}
                onComment={handleComment}
                onRepost={handleRepost}
              />
            ))}
          </div>
        )}

        {memos.hasNextPage && !memos.isFetchingNextPage && (
          <div className="py-6 text-center">
            <Button
              variant="secondary"
              onClick={() => void memos.fetchNextPage()}
            >
              加载更多
            </Button>
          </div>
        )}
        {memos.isFetchingNextPage && (
          <div className="flex justify-center py-6">
            <Loader size="sm" />
          </div>
        )}
      </main>

      <MemoCommentsDialog
        open={commentOpen}
        onOpenChange={setCommentOpen}
        memo={commenting}
        onCountsChange={(counts) =>
          commenting && patchItem(commenting.id, { counts })
        }
      />
      <RepostDialog
        open={repostOpen}
        onOpenChange={setRepostOpen}
        memo={reposting}
        onReposted={(counts, reposted, content) =>
          reposting && handleReposted(reposting, counts, reposted, content)
        }
      />
    </div>
  )
}

function ProfileHeader({ profile }: { profile: PublicProfile }) {
  return (
    <section className="grid gap-4">
      <div className="flex items-center gap-4">
        <Avatar
          username={profile.username}
          image={profile.image}
          size={64}
          className="shrink-0"
        />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-kumo-strong">
            {profile.name}
          </h1>
          <p className="font-mono text-sm text-kumo-subtle">
            @{profile.username}
          </p>
        </div>
      </div>
      {profile.bio && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-kumo-default">
          {profile.bio}
        </p>
      )}
      <div className="flex items-center gap-5 text-xs text-kumo-subtle">
        <span>
          公开 memo{' '}
          <span className="font-mono text-[0.9em] text-kumo-default">
            {profile.stats.memos}
          </span>
        </span>
        <span>
          转发{' '}
          <span className="font-mono text-[0.9em] text-kumo-default">
            {profile.stats.reposts}
          </span>
        </span>
        <span>加入于 {new Date(profile.createdAt).getFullYear()}</span>
      </div>
    </section>
  )
}
