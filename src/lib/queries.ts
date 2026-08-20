import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'

import type { HomeSearch } from './search'
import { getAdminGate, getAdminOverview } from '#/server/admin'
import { listApiKeys } from '#/server/api-keys'
import { getAppConfig } from '#/server/config'
import { listComments, listInteractions } from '#/server/interactions'
import type { InteractionKind } from '#/server/timeline-core'
import {
  getContributionGraph,
  getMemoDetail,
  getStats,
  listHomeFeed,
  listMemoVersions,
} from '#/server/memos'
import {
  getUnreadNotificationCount,
  listNotifications,
} from '#/server/notifications'
import { getMyProfile } from '#/server/profile'
import {
  getPublicMemo,
  getPublicProfile,
  listPublicMemos,
  listPublicTimeline,
} from '#/server/public'
import { listTags } from '#/server/tags'

const PAGE_SIZE = 20
const firstPage = null as string | null

export const queryKeys = {
  config: ['config'] as const,
  admin: ['admin'] as const,
  apiKeys: ['api-keys'] as const,
  profile: ['profile'] as const,
  memos: ['memos'] as const,
  tags: ['tags'] as const,
  stats: ['stats'] as const,
  contribution: ['contribution'] as const,
  comments: ['comments'] as const,
  interactions: ['interactions'] as const,
  notifications: ['notifications'] as const,
  public: ['public'] as const,
}

export const appConfigQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.config,
    queryFn: () => getAppConfig(),
    staleTime: 60_000,
  })

export const adminGateQueryOptions = () =>
  queryOptions({
    queryKey: [...queryKeys.admin, 'gate'] as const,
    queryFn: () => getAdminGate(),
  })

export const adminOverviewQueryOptions = () =>
  queryOptions({
    queryKey: [...queryKeys.admin, 'overview'] as const,
    queryFn: () => getAdminOverview(),
  })

export const apiKeysQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.apiKeys, queryFn: () => listApiKeys() })

export const myProfileQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.profile, queryFn: () => getMyProfile() })

export type HomeFeedFilters = HomeSearch & { tzOffsetMinutes: number }

export const homeFeedQueryOptions = (filters: HomeFeedFilters) =>
  infiniteQueryOptions({
    queryKey: [...queryKeys.memos, 'home', filters] as const,
    queryFn: ({ pageParam }) =>
      listHomeFeed({
        data: {
          ...filters,
          cursor: pageParam ?? undefined,
          limit: PAGE_SIZE,
        },
      }),
    initialPageParam: firstPage,
    getNextPageParam: (page) => page.nextCursor,
  })

export const tagsQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.tags, queryFn: () => listTags() })

export const statsQueryOptions = (tzOffsetMinutes: number) =>
  queryOptions({
    queryKey: [...queryKeys.stats, tzOffsetMinutes] as const,
    queryFn: () => getStats({ data: { tzOffsetMinutes } }),
  })

export const contributionQueryOptions = (
  month: string | undefined,
  tzOffsetMinutes: number,
) =>
  queryOptions({
    queryKey: [...queryKeys.contribution, month, tzOffsetMinutes] as const,
    queryFn: () => getContributionGraph({ data: { month, tzOffsetMinutes } }),
  })

export const memoDetailQueryOptions = (id: string) =>
  queryOptions({
    queryKey: [...queryKeys.memos, 'detail', id] as const,
    queryFn: () => getMemoDetail({ data: { id } }),
  })

export const memoVersionsQueryOptions = (memoId: string) =>
  queryOptions({
    queryKey: [...queryKeys.memos, 'versions', memoId] as const,
    queryFn: () => listMemoVersions({ data: { memoId } }),
  })

export const commentsQueryOptions = (memoId: string) =>
  infiniteQueryOptions({
    queryKey: [...queryKeys.comments, memoId] as const,
    queryFn: ({ pageParam }) =>
      listComments({
        data: {
          memoId,
          cursor: pageParam ?? undefined,
          limit: PAGE_SIZE,
        },
      }),
    initialPageParam: firstPage,
    getNextPageParam: (page) => page.nextCursor,
  })

export const interactionsQueryOptions = (kind: InteractionKind) =>
  infiniteQueryOptions({
    queryKey: [...queryKeys.interactions, kind] as const,
    queryFn: ({ pageParam }) =>
      listInteractions({
        data: {
          kind,
          cursor: pageParam ?? undefined,
          limit: PAGE_SIZE,
        },
      }),
    initialPageParam: firstPage,
    getNextPageParam: (page) => page.nextCursor,
  })

export const notificationsQueryOptions = () =>
  infiniteQueryOptions({
    queryKey: [...queryKeys.notifications, 'list'] as const,
    queryFn: ({ pageParam }) =>
      listNotifications({
        data: { cursor: pageParam ?? undefined, limit: PAGE_SIZE },
      }),
    initialPageParam: firstPage,
    getNextPageParam: (page) => page.nextCursor,
  })

export const unreadNotificationsQueryOptions = () =>
  queryOptions({
    queryKey: [...queryKeys.notifications, 'unread'] as const,
    queryFn: () => getUnreadNotificationCount(),
  })

export const publicProfileQueryOptions = (username: string) =>
  queryOptions({
    queryKey: [...queryKeys.public, 'profile', username] as const,
    queryFn: () => getPublicProfile({ data: { username } }),
    staleTime: 60_000,
  })

export const publicMemosQueryOptions = (username: string, tag?: string) =>
  infiniteQueryOptions({
    queryKey: [
      ...queryKeys.public,
      'profile-memos',
      username,
      { tag },
    ] as const,
    queryFn: ({ pageParam }) =>
      listPublicMemos({
        data: {
          username,
          tag,
          cursor: pageParam ?? undefined,
          limit: PAGE_SIZE,
        },
      }),
    initialPageParam: firstPage,
    getNextPageParam: (page) => page.nextCursor,
  })

export const publicTimelineQueryOptions = (tag: string | undefined) =>
  infiniteQueryOptions({
    queryKey: [...queryKeys.public, 'timeline', { tag }] as const,
    queryFn: ({ pageParam }) =>
      listPublicTimeline({
        data: { cursor: pageParam ?? undefined, limit: PAGE_SIZE, tag },
      }),
    initialPageParam: firstPage,
    getNextPageParam: (page) => page.nextCursor,
  })

export const publicMemoQueryOptions = (username: string, memoId: string) =>
  queryOptions({
    queryKey: [...queryKeys.public, 'memo', username, memoId] as const,
    queryFn: () => getPublicMemo({ data: { username, memoId } }),
  })

export function mapInfiniteItems<
  TPage extends { items: unknown[] },
  TPageParam,
>(
  data: InfiniteData<TPage, TPageParam> | undefined,
  update: (item: TPage['items'][number]) => TPage['items'][number] | null,
): InfiniteData<TPage, TPageParam> | undefined {
  if (!data) return data
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.flatMap((item) => {
        const next = update(item)
        return next ? [next] : []
      }),
    })),
  }
}
