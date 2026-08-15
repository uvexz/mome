import {
  createFileRoute,
  redirect,
  useNavigate,
  useSearch,
} from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Loader, useKumoToastManager } from '@cloudflare/kumo'

import { Composer } from '#/components/composer'
import { ContributionGraph } from '#/components/contribution-graph'
import { DeleteMemoDialog } from '#/components/delete-memo-dialog'
import { EditMemoDialog } from '#/components/edit-memo-dialog'
import { EmptyState } from '#/components/empty-state'
import { MemoCommentsDialog } from '#/components/memo-comments-dialog'
import { MemoFeed } from '#/components/memo-feed'
import { RepostDialog } from '#/components/repost-dialog'
import { SearchFiltersDialog } from '#/components/search-filters-dialog'
import { SiteHeader } from '#/components/site-header'
import { TagList } from '#/components/tag-list'
import {
  contributionQueryOptions,
  homeFeedQueryOptions,
  mapInfiniteItems,
  queryKeys,
  statsQueryOptions,
  tagsQueryOptions,
} from '#/lib/queries'
import { homeSearchSchema } from '#/lib/search'
import { toggleFavorite, toggleLike } from '#/server/interactions'
import {
  deleteMemo,
  purgeMemo,
  restoreDeletedMemo,
  setVisibility,
  toggleArchive,
  togglePin,
  updateMemo,
} from '#/server/memos'
import type { MemoCounts } from '#/server/interactions-core'
import type { MemoWithTags } from '#/server/memos'
import type { TimelineItem } from '#/server/timeline-core'
import { getSessionUser } from '#/server/session'

export const Route = createFileRoute('/')({
  validateSearch: homeSearchSchema,
  beforeLoad: async () => {
    const user = await getSessionUser()
    if (!user) throw redirect({ to: '/explore' })
  },
  component: Home,
})

function Home() {
  const search = useSearch({ from: '/' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const tzOffsetMinutes = new Date().getTimezoneOffset()
  const feedOptions = homeFeedQueryOptions({ ...search, tzOffsetMinutes })
  const feed = useInfiniteQuery(feedOptions)
  const items = feed.data?.pages.flatMap((page) => page.items) ?? []
  const tagsQuery = useQuery(tagsQueryOptions())
  const statsQuery = useQuery(statsQueryOptions(tzOffsetMinutes))
  const [contributionMonth, setContributionMonth] = useState<string>()
  const contributionQuery = useQuery({
    ...contributionQueryOptions(contributionMonth, tzOffsetMinutes),
    placeholderData: keepPreviousData,
  })
  const tags = tagsQuery.data ?? []
  const stats = statsQuery.data ?? null
  const contribution = contributionQuery.data ?? null
  const loading = feed.isPending || feed.isFetchingNextPage
  const hasMore = Boolean(feed.hasNextPage)
  const [editing, setEditing] = useState<MemoWithTags | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [deleting, setDeleting] = useState<MemoWithTags | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [commenting, setCommenting] = useState<MemoWithTags | null>(null)
  const [commentOpen, setCommentOpen] = useState(false)
  const [reposting, setReposting] = useState<MemoWithTags | null>(null)
  const [repostOpen, setRepostOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)

  const hasFilters = Boolean(
    search.tag ||
    search.q ||
    search.visibility ||
    search.favorited ||
    search.from ||
    search.to,
  )
  const hasContentFilters = Boolean(
    search.visibility || search.favorited || search.from || search.to,
  )

  // ── 加载 ────────────────────────────────────────────────
  const loadMore = useCallback(() => {
    void feed.fetchNextPage()
  }, [feed.fetchNextPage])

  useEffect(() => {
    if (feed.isError) {
      toast.add({ title: '加载失败', variant: 'error' })
    }
  }, [feed.errorUpdatedAt, feed.isError, toast])

  function refreshMetadata() {
    for (const queryKey of [
      queryKeys.tags,
      queryKeys.stats,
      queryKeys.contribution,
    ]) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }

  function markOtherMemoViewsStale() {
    for (const queryKey of [queryKeys.public, queryKeys.interactions]) {
      void queryClient.invalidateQueries({ queryKey, refetchType: 'none' })
    }
  }

  function changeContributionMonth(month: string) {
    if (contributionQuery.isFetching || !contribution) return
    setContributionMonth(month)
  }

  function removeMemo(id: string) {
    queryClient.setQueryData(feedOptions.queryKey, (data) =>
      mapInfiniteItems(data, (item) => (item.memo.id === id ? null : item)),
    )
  }

  // ── 变更 ────────────────────────────────────────────────
  function handleCreated(memo: MemoWithTags) {
    refreshMetadata()
    markOtherMemoViewsStale()
    if (search.tag || search.q || search.filter) {
      // 当前视图有筛选/归档时，乐观插入可能不符合视图条件，改为按当前条件重载
      void feed.refetch()
    } else {
      queryClient.setQueryData(feedOptions.queryKey, (data) => {
        if (!data || data.pages.length === 0) return data
        const pages = [...data.pages]
        const first = pages[0]
        const pinnedCount = first.items.filter(
          (i) => i.kind === 'memo' && i.memo.pinned,
        ).length
        const next = [...first.items]
        const item: TimelineItem = {
          kind: 'memo',
          memo,
          author: null,
          repost: null,
        }
        next.splice(pinnedCount, 0, item)
        pages[0] = { ...first, items: next }
        return { ...data, pages }
      })
    }
    toast.add({ title: '已记录', variant: 'success' })
  }

  async function handleEdit(memo: MemoWithTags, content: string) {
    try {
      const updated = await updateMemo({ data: { id: memo.id, content } })
      refreshMetadata()
      markOtherMemoViewsStale()
      if (search.tag || search.q) {
        await feed.refetch()
      } else {
        patchMemo(updated.id, updated)
      }
      toast.add({ title: '已保存', variant: 'success' })
    } catch (err) {
      toast.add({
        title: '保存失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
      throw err // 让对话框保持打开并显示错误
    }
  }

  async function handleTogglePin(memo: MemoWithTags) {
    try {
      const res = await togglePin({ data: { id: memo.id } })
      await feed.refetch() // 置顶变化会影响排序，整体重载
      toast.add({
        title: res.pinned ? '已置顶' : '已取消置顶',
        variant: 'success',
      })
    } catch {
      toast.add({ title: '操作失败', variant: 'error' })
    }
  }

  async function handleToggleArchive(memo: MemoWithTags) {
    try {
      const res = await toggleArchive({ data: { id: memo.id } })
      // 归档/恢复后不再属于当前视图，直接移除
      removeMemo(memo.id)
      refreshMetadata()
      markOtherMemoViewsStale()
      toast.add({
        title: res.archived ? '已归档' : '已恢复',
        variant: 'success',
      })
    } catch (err) {
      toast.add({
        title: '操作失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
      void feed.refetch() // 失败时重新同步列表
    }
  }

  async function handleDelete() {
    if (!deleting) return
    try {
      const permanent = Boolean(deleting.deletedAt)
      if (permanent) {
        await purgeMemo({ data: { id: deleting.id } })
      } else {
        await deleteMemo({ data: { id: deleting.id } })
      }
      removeMemo(deleting.id)
      refreshMetadata()
      markOtherMemoViewsStale()
      setDeleteOpen(false)
      setDeleting(null)
      toast.add({
        title: permanent ? '已永久删除' : '已移至回收站',
        variant: 'success',
      })
    } catch (err) {
      toast.add({
        title: '删除失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
      setDeleteOpen(false)
      setDeleting(null)
      void feed.refetch() // 失败时重新同步列表
    }
  }

  async function handleRestore(memo: MemoWithTags) {
    try {
      const result = await restoreDeletedMemo({ data: { id: memo.id } })
      if (!result.restored) throw new Error('memo 已恢复或不存在')
      removeMemo(memo.id)
      refreshMetadata()
      markOtherMemoViewsStale()
      toast.add({ title: '已恢复', variant: 'success' })
    } catch (err) {
      toast.add({
        title: '恢复失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
      void feed.refetch()
    }
  }

  // ── 互动 ───────────────────────────────────────────────
  function patchMemo(id: string, patch: Partial<MemoWithTags>) {
    queryClient.setQueryData(feedOptions.queryKey, (data) =>
      mapInfiniteItems(data, (item) =>
        item.memo.id === id
          ? { ...item, memo: { ...item.memo, ...patch } }
          : item,
      ),
    )
  }

  async function handleToggleVisibility(memo: MemoWithTags) {
    try {
      const next = memo.visibility === 'public' ? 'private' : 'public'
      const res = await setVisibility({
        data: { id: memo.id, visibility: next },
      })
      patchMemo(memo.id, { visibility: res.visibility })
      markOtherMemoViewsStale()
      toast.add({
        title: res.visibility === 'public' ? '已设为公开' : '已设为私密',
        variant: 'success',
      })
    } catch {
      toast.add({ title: '操作失败', variant: 'error' })
    }
  }

  async function handleLike(memo: MemoWithTags) {
    try {
      const res = await toggleLike({ data: { memoId: memo.id } })
      patchMemo(memo.id, {
        counts: res.counts,
        viewerState: { ...memo.viewerState, liked: res.liked },
      })
      markOtherMemoViewsStale()
    } catch (err) {
      toast.add({
        title: '点赞失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    }
  }

  async function handleFavorite(memo: MemoWithTags) {
    try {
      const res = await toggleFavorite({ data: { memoId: memo.id } })
      patchMemo(memo.id, {
        counts: res.counts,
        viewerState: { ...memo.viewerState, favorited: res.favorited },
      })
      markOtherMemoViewsStale()
    } catch (err) {
      toast.add({
        title: '收藏失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    }
  }

  function handleCommentCountsChange(memo: MemoWithTags, counts: MemoCounts) {
    patchMemo(memo.id, { counts })
    markOtherMemoViewsStale()
  }

  function handleReposted(
    memo: MemoWithTags,
    counts: MemoCounts,
    reposted: boolean,
    content: string | null,
  ) {
    patchMemo(memo.id, {
      counts,
      viewerState: {
        ...memo.viewerState,
        reposted,
        repostedContent: content,
      },
    })
    markOtherMemoViewsStale()
  }

  // ── 导航（search params 驱动） ──────────────────────────
  function updateSearch(patch: Partial<HomeSearchLike>) {
    void navigate({
      to: '/',
      search: (prev) => {
        const next = { ...prev, ...patch }
        // 空值从 URL 中移除
        for (const key of [
          'tag',
          'q',
          'filter',
          'visibility',
          'favorited',
          'from',
          'to',
        ] as const) {
          if (next[key] === undefined || next[key] === '') delete next[key]
        }
        return next
      },
      replace: false,
    })
  }

  const archivedView = search.filter === 'archived'
  const deletedView = search.filter === 'deleted'

  return (
    <div className="min-h-dvh">
      <SiteHeader search={search} onSearchChange={(q) => updateSearch({ q })} />

      <main className="mx-auto w-full max-w-[640px] px-4 pb-24 pt-8">
        <div className="grid gap-6">
          {!deletedView && (
            <Composer
              onCreated={handleCreated}
              onQueued={() =>
                toast.add({
                  title: '已离线保存，联网后自动发送',
                  variant: 'success',
                })
              }
              onError={(msg) => toast.add({ title: msg, variant: 'error' })}
            />
          )}

          {/* 小窗口：贡献图 + 标签列表（发布框下方） */}
          {!deletedView && (
            <div className="grid gap-6 xl:hidden">
              <ContributionGraph
                data={contribution}
                loading={contributionQuery.isFetching}
                collapsible
                onMonthChange={(m) => void changeContributionMonth(m)}
              />
              {!archivedView && (
                <TagList
                  tags={tags}
                  currentTag={search.tag}
                  onSelect={(tag) => updateSearch({ tag: tag ?? undefined })}
                />
              )}
            </div>
          )}

          {loading && items.length === 0 ? (
            <div className="flex justify-center py-16">
              <Loader size="base" />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              hasFilters={hasFilters}
              view={
                deletedView ? 'deleted' : archivedView ? 'archived' : 'default'
              }
              onClear={() =>
                updateSearch({
                  tag: undefined,
                  q: undefined,
                  filter: deletedView
                    ? 'deleted'
                    : archivedView
                      ? 'archived'
                      : undefined,
                  visibility: undefined,
                  favorited: undefined,
                  from: undefined,
                  to: undefined,
                })
              }
            />
          ) : (
            <MemoFeed
              items={items}
              deleted={deletedView}
              hasMore={hasMore}
              loading={loading}
              onLoadMore={loadMore}
              onTogglePin={(m) => void handleTogglePin(m)}
              onEdit={(m) => {
                setEditing(m)
                setEditOpen(true)
              }}
              onReference={(memo) =>
                void navigate({
                  to: '/capture',
                  search: { reference: memo.id },
                })
              }
              onToggleArchive={(m) => void handleToggleArchive(m)}
              onDelete={(m) => {
                setDeleting(m)
                setDeleteOpen(true)
              }}
              onRestore={(m) => void handleRestore(m)}
              onPurge={(m) => {
                setDeleting(m)
                setDeleteOpen(true)
              }}
              onToggleVisibility={(m) => void handleToggleVisibility(m)}
              onLike={(m) => void handleLike(m)}
              onFavorite={(m) => void handleFavorite(m)}
              onComment={(m) => {
                setCommenting(m)
                setCommentOpen(true)
              }}
              onRepost={(m) => {
                setReposting(m)
                setRepostOpen(true)
              }}
              onFilter={() => setFiltersOpen(true)}
              filterActive={hasContentFilters}
            />
          )}

          {!hasMore && items.length > 0 && (
            <p className="py-4 text-center font-mono text-xs text-kumo-inactive">
              — 到底了 —
            </p>
          )}

          {stats && !deletedView && (
            <footer className="mt-4 flex items-center justify-center gap-6 border-t border-kumo-line pt-6 text-xs text-kumo-subtle">
              <span>
                共{' '}
                <span className="font-mono text-[0.9em] text-kumo-default">
                  {stats.total}
                </span>{' '}
                条
              </span>
              <span>
                连续记录{' '}
                <span className="font-mono text-[0.9em] text-kumo-default">
                  {stats.streak}
                </span>{' '}
                天
              </span>
            </footer>
          )}
        </div>
      </main>

      {/* 大窗口：贡献图 + 标签列表，全局右侧低调显示 */}
      {!deletedView && (
        <aside className="fixed right-6 top-24 z-30 hidden max-h-[calc(100dvh-7rem)] w-64 overflow-y-auto xl:block">
          <div className="grid gap-6">
            <ContributionGraph
              data={contribution}
              loading={contributionQuery.isFetching}
              onMonthChange={(m) => void changeContributionMonth(m)}
            />
            {!archivedView && (
              <div className="px-3 pb-3">
                <TagList
                  tags={tags}
                  currentTag={search.tag}
                  onSelect={(tag) => updateSearch({ tag: tag ?? undefined })}
                />
              </div>
            )}
          </div>
        </aside>
      )}

      <EditMemoDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        memo={editing}
        onSave={(content) =>
          editing ? handleEdit(editing, content) : Promise.resolve()
        }
      />
      <DeleteMemoDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        memo={deleting}
        permanent={Boolean(deleting?.deletedAt)}
        onConfirm={handleDelete}
      />
      <MemoCommentsDialog
        open={commentOpen}
        onOpenChange={setCommentOpen}
        memo={commenting}
        onCountsChange={(counts) =>
          commenting && handleCommentCountsChange(commenting, counts)
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
      <SearchFiltersDialog
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        value={search}
        onApply={updateSearch}
      />
    </div>
  )
}

type HomeSearchLike = {
  tag?: string
  q?: string
  filter?: 'all' | 'archived' | 'deleted'
  visibility?: 'public' | 'private'
  favorited?: boolean
  from?: string
  to?: string
}
