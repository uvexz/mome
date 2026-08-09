import {
  createFileRoute,
  redirect,
  useNavigate,
  useSearch,
} from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader, Tabs, useKumoToastManager } from '@cloudflare/kumo'

import { Composer } from '#/components/composer'
import { ContributionGraph } from '#/components/contribution-graph'
import { DeleteMemoDialog } from '#/components/delete-memo-dialog'
import { EditMemoDialog } from '#/components/edit-memo-dialog'
import { EmptyState } from '#/components/empty-state'
import { MemoCommentsDialog } from '#/components/memo-comments-dialog'
import { MemoFeed } from '#/components/memo-feed'
import { RepostDialog } from '#/components/repost-dialog'
import { SiteHeader } from '#/components/site-header'
import { TagList } from '#/components/tag-list'
import { homeSearchSchema } from '#/lib/search'
import { toggleFavorite, toggleLike } from '#/server/interactions'
import {
  deleteMemo,
  getContributionGraph,
  getStats,
  listHomeFeed,
  purgeMemo,
  restoreDeletedMemo,
  setVisibility,
  toggleArchive,
  togglePin,
  updateMemo,
} from '#/server/memos'
import type { MemoCounts } from '#/server/interactions-core'
import type { ContributionMonthData, MemoWithTags } from '#/server/memos'
import type { TimelineItem } from '#/server/timeline-core'
import { getSessionUser } from '#/server/session'
import { listTags } from '#/server/tags'
import type { TagWithCount } from '#/server/tags'

const PAGE_SIZE = 20

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
  const toast = useKumoToastManager()

  const [items, setItems] = useState<TimelineItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [tags, setTags] = useState<TagWithCount[]>([])
  const [stats, setStats] = useState<{ total: number; streak: number } | null>(
    null,
  )
  const [contribution, setContribution] =
    useState<ContributionMonthData | null>(null)
  const [contributionLoading, setContributionLoading] = useState(false)
  const [editing, setEditing] = useState<MemoWithTags | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [deleting, setDeleting] = useState<MemoWithTags | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [commenting, setCommenting] = useState<MemoWithTags | null>(null)
  const [commentOpen, setCommentOpen] = useState(false)
  const [reposting, setReposting] = useState<MemoWithTags | null>(null)
  const [repostOpen, setRepostOpen] = useState(false)

  // 避免闭包捕获过期值
  const searchRef = useRef(search)
  searchRef.current = search
  const toastRef = useRef(toast)
  toastRef.current = toast
  const cursorRef = useRef<string | null>(null)
  const loadingRef = useRef(false)
  const reqIdRef = useRef(0)
  const monthRef = useRef<string | null>(null)

  const hasFilters = Boolean(
    search.tag ||
    search.q ||
    search.visibility ||
    search.favorited ||
    search.from ||
    search.to,
  )

  // ── 加载 ────────────────────────────────────────────────
  const loadInitial = useCallback(async () => {
    const id = ++reqIdRef.current
    loadingRef.current = true
    setLoading(true)
    try {
      const s = searchRef.current
      const [memoRes, tagRes, statsRes, graphRes] = await Promise.all([
        listHomeFeed({
          data: {
            limit: PAGE_SIZE,
            tag: s.tag,
            q: s.q,
            filter: s.filter,
            visibility: s.visibility,
            favorited: s.favorited,
            from: s.from,
            to: s.to,
            tzOffsetMinutes: new Date().getTimezoneOffset(),
          },
        }),
        listTags(),
        getStats({
          data: { tzOffsetMinutes: new Date().getTimezoneOffset() },
        }),
        getContributionGraph({
          data: {
            month: monthRef.current ?? undefined,
            tzOffsetMinutes: new Date().getTimezoneOffset(),
          },
        }),
      ])
      if (id !== reqIdRef.current) return
      setItems(memoRes.items)
      cursorRef.current = memoRes.nextCursor
      setHasMore(memoRes.nextCursor !== null)
      setTags(tagRes)
      setStats(statsRes)
      setContribution(graphRes)
      monthRef.current = graphRes.month
    } catch {
      if (id === reqIdRef.current) {
        toastRef.current.add({ title: '加载失败', variant: 'error' })
      }
    } finally {
      loadingRef.current = false
      if (id === reqIdRef.current) setLoading(false)
    }
  }, [])

  const loadMore = useCallback(async () => {
    if (loadingRef.current || !cursorRef.current) return
    loadingRef.current = true
    const id = ++reqIdRef.current
    try {
      const s = searchRef.current
      const res = await listHomeFeed({
        data: {
          cursor: cursorRef.current,
          limit: PAGE_SIZE,
          tag: s.tag,
          q: s.q,
          filter: s.filter,
          visibility: s.visibility,
          favorited: s.favorited,
          from: s.from,
          to: s.to,
          tzOffsetMinutes: new Date().getTimezoneOffset(),
        },
      })
      if (id !== reqIdRef.current) return
      setItems((prev) => [...prev, ...res.items])
      cursorRef.current = res.nextCursor
      setHasMore(res.nextCursor !== null)
    } catch {
      if (id === reqIdRef.current) {
        toastRef.current.add({ title: '加载更多失败', variant: 'error' })
      }
    } finally {
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    void loadInitial()
    // loadInitial 稳定；search 变化时靠下方依赖触发重载
  }, [
    search.tag,
    search.q,
    search.filter,
    search.visibility,
    search.favorited,
    search.from,
    search.to,
  ])

  const refreshTags = useCallback(async () => {
    try {
      setTags(await listTags())
    } catch {
      // 静默失败
    }
  }, [])

  const refreshContribution = useCallback(async () => {
    try {
      const res = await getContributionGraph({
        data: {
          month: monthRef.current ?? undefined,
          tzOffsetMinutes: new Date().getTimezoneOffset(),
        },
      })
      setContribution(res)
      monthRef.current = res.month
    } catch {
      // 静默失败
    }
  }, [])

  async function changeContributionMonth(month: string) {
    if (contributionLoading || !contribution) return
    monthRef.current = month
    setContributionLoading(true)
    try {
      const res = await getContributionGraph({
        data: {
          month,
          tzOffsetMinutes: new Date().getTimezoneOffset(),
        },
      })
      setContribution(res)
      monthRef.current = res.month
    } catch {
      toastRef.current.add({ title: '月份加载失败', variant: 'error' })
    } finally {
      setContributionLoading(false)
    }
  }

  // ── 变更 ────────────────────────────────────────────────
  function handleCreated(memo: MemoWithTags) {
    void refreshTags()
    void refreshContribution()
    const s = searchRef.current
    if (s.tag || s.q || s.filter) {
      // 当前视图有筛选/归档时，乐观插入可能不符合视图条件，改为按当前条件重载
      void loadInitial()
    } else {
      setItems((prev) => {
        const pinnedCount = prev.filter(
          (i) => i.kind === 'memo' && i.memo.pinned,
        ).length
        const next = [...prev]
        next.splice(pinnedCount, 0, {
          kind: 'memo',
          memo,
          author: null,
          repost: null,
        })
        return next
      })
    }
    toastRef.current.add({ title: '已记录', variant: 'success' })
  }

  async function handleEdit(memo: MemoWithTags, content: string) {
    try {
      const updated = await updateMemo({ data: { id: memo.id, content } })
      void refreshTags()
      if (searchRef.current.tag || searchRef.current.q) {
        await loadInitial()
      } else {
        setItems((prev) =>
          prev.map((i) =>
            i.memo.id === updated.id ? { ...i, memo: updated } : i,
          ),
        )
      }
      toastRef.current.add({ title: '已保存', variant: 'success' })
    } catch (err) {
      toastRef.current.add({
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
      await loadInitial() // 置顶变化会影响排序，整体重载
      toastRef.current.add({
        title: res.pinned ? '已置顶' : '已取消置顶',
        variant: 'success',
      })
    } catch {
      toastRef.current.add({ title: '操作失败', variant: 'error' })
    }
  }

  async function handleToggleArchive(memo: MemoWithTags) {
    try {
      const res = await toggleArchive({ data: { id: memo.id } })
      // 归档/恢复后不再属于当前视图，直接移除
      setItems((prev) => prev.filter((i) => i.memo.id !== memo.id))
      void refreshTags()
      void refreshContribution()
      toastRef.current.add({
        title: res.archived ? '已归档' : '已恢复',
        variant: 'success',
      })
    } catch (err) {
      toastRef.current.add({
        title: '操作失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
      void loadInitial() // 失败时重新同步列表
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
      setItems((prev) => prev.filter((i) => i.memo.id !== deleting.id))
      void refreshTags()
      void refreshContribution()
      setDeleteOpen(false)
      setDeleting(null)
      toastRef.current.add({
        title: permanent ? '已永久删除' : '已移至回收站',
        variant: 'success',
      })
    } catch (err) {
      toastRef.current.add({
        title: '删除失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
      setDeleteOpen(false)
      setDeleting(null)
      void loadInitial() // 失败时重新同步列表
    }
  }

  async function handleRestore(memo: MemoWithTags) {
    try {
      const result = await restoreDeletedMemo({ data: { id: memo.id } })
      if (!result.restored) throw new Error('memo 已恢复或不存在')
      setItems((prev) => prev.filter((item) => item.memo.id !== memo.id))
      void refreshTags()
      void refreshContribution()
      toastRef.current.add({ title: '已恢复', variant: 'success' })
    } catch (err) {
      toastRef.current.add({
        title: '恢复失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
      void loadInitial()
    }
  }

  // ── 互动 ───────────────────────────────────────────────
  function patchMemo(id: string, patch: Partial<MemoWithTags>) {
    setItems((prev) =>
      prev.map((i) =>
        i.memo.id === id ? { ...i, memo: { ...i.memo, ...patch } } : i,
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
      toastRef.current.add({
        title: res.visibility === 'public' ? '已设为公开' : '已设为私密',
        variant: 'success',
      })
    } catch {
      toastRef.current.add({ title: '操作失败', variant: 'error' })
    }
  }

  async function handleLike(memo: MemoWithTags) {
    try {
      const res = await toggleLike({ data: { memoId: memo.id } })
      patchMemo(memo.id, {
        counts: res.counts,
        viewerState: { ...memo.viewerState, liked: res.liked },
      })
    } catch (err) {
      toastRef.current.add({
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
    } catch (err) {
      toastRef.current.add({
        title: '收藏失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    }
  }

  function handleCommentCountChange(memo: MemoWithTags, count: number) {
    setItems((prev) =>
      prev.map((i) =>
        i.memo.id === memo.id
          ? {
              ...i,
              memo: {
                ...i.memo,
                counts: { ...i.memo.counts, comments: count },
              },
            }
          : i,
      ),
    )
  }

  function handleReposted(
    memo: MemoWithTags,
    counts: MemoCounts,
    reposted: boolean,
    content: string | null,
  ) {
    setItems((prev) =>
      prev.map((i) =>
        i.memo.id === memo.id
          ? {
              ...i,
              memo: {
                ...i.memo,
                counts,
                viewerState: {
                  ...i.memo.viewerState,
                  reposted,
                  repostedContent: content,
                },
              },
            }
          : i,
      ),
    )
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
  const activeView = deletedView ? 'deleted' : archivedView ? 'archived' : 'all'

  return (
    <div className="min-h-dvh">
      <SiteHeader
        search={search}
        onSearchChange={(q) => updateSearch({ q })}
        onFilterChange={updateSearch}
      />

      <main className="mx-auto w-full max-w-[640px] px-4 pb-24 pt-8">
        <div className="grid gap-6">
          <Tabs
            value={activeView}
            variant="segmented"
            tabs={[
              {
                value: 'all',
                label: '我的',
                className: 'flex-1 justify-center text-sm',
              },
              {
                value: 'archived',
                label: '归档',
                className: 'flex-1 justify-center text-sm',
              },
              {
                value: 'deleted',
                label: '回收站',
                className: 'flex-1 justify-center text-sm',
              },
            ]}
            onValueChange={(value) =>
              updateSearch({
                filter:
                  value === 'archived' || value === 'deleted'
                    ? value
                    : undefined,
              })
            }
          />

          {!deletedView && (
            <Composer
              onCreated={handleCreated}
              onQueued={() =>
                toastRef.current.add({
                  title: '已离线保存，联网后自动发送',
                  variant: 'success',
                })
              }
              onError={(msg) =>
                toastRef.current.add({ title: msg, variant: 'error' })
              }
            />
          )}

          {/* 小窗口：贡献图 + 标签列表（发布框下方） */}
          {!deletedView && (
            <div className="grid gap-6 xl:hidden">
              <ContributionGraph
                data={contribution}
                loading={contributionLoading}
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
              loading={contributionLoading}
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
        onCountChange={(count) =>
          commenting && handleCommentCountChange(commenting, count)
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

type HomeSearchLike = {
  tag?: string
  q?: string
  filter?: 'all' | 'archived' | 'deleted'
  visibility?: 'public' | 'private'
  favorited?: boolean
  from?: string
  to?: string
}
