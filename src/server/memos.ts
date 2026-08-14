import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { authMiddleware } from './middleware'
import { rateLimitOrThrow } from './rate-limit'
import {
  getContributionForUser,
  createMemoForUser,
  deleteMemoForUser,
  exportMemosForUser,
  getRandomMemosForUser,
  getMemoConnectionsForUser,
  getMemoForUser,
  getReviewMemosForUser,
  getStatsForUser,
  importMemosForUser,
  listMemoVersionsForUser,
  listMemosForUser,
  MAX_CONTENT,
  purgeMemoForUser,
  restoreDeletedMemoForUser,
  restoreMemoVersionForUser,
  setVisibilityForUser,
  toggleArchiveForUser,
  togglePinForUser,
  updateMemoForUser,
} from './memos-core'
import type {
  ContributionDay,
  ContributionMonthData,
  MemoWithTags,
} from './memos-core'
import { listHomeFeedForUser } from './timeline-core'

export type { MemoWithTags }
export type { ContributionDay, ContributionMonthData }
export type { MemoConnections, MemoVersionItem, ReviewMode } from './memos-core'

export const createMemo = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      content: z.string().trim().min(1).max(MAX_CONTENT),
      visibility: z.enum(['public', 'private']).default('private'),
      clientId: z.string().uuid().optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    createMemoForUser(context.user.id, data.content, {
      visibility: data.visibility,
      clientId: data.clientId,
    }),
  )

export const listMemos = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      cursor: z.string().max(256).optional(),
      limit: z.number().int().min(1).max(50).default(20),
      tag: z.string().optional(),
      q: z.string().max(200).optional(),
      filter: z.enum(['all', 'archived', 'deleted']).optional(),
      visibility: z.enum(['public', 'private']).optional(),
      favorited: z.boolean().optional(),
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      tzOffsetMinutes: z.number().int().min(-840).max(840).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    listMemosForUser(context.user.id, {
      cursor: data.cursor,
      limit: data.limit,
      tag: data.tag,
      q: data.q,
      filter: data.filter,
      visibility: data.visibility,
      favorited: data.favorited,
      from: data.from,
      to: data.to,
      tzOffsetMinutes: data.tzOffsetMinutes,
    }),
  )

/** 个人时间线：自己的 memo + 转发的他人公开 memo */
export const listHomeFeed = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      cursor: z.string().max(256).optional(),
      limit: z.number().int().min(1).max(50).default(20),
      tag: z.string().optional(),
      q: z.string().max(200).optional(),
      filter: z.enum(['all', 'archived', 'deleted']).optional(),
      visibility: z.enum(['public', 'private']).optional(),
      favorited: z.boolean().optional(),
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      tzOffsetMinutes: z.number().int().min(-840).max(840).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    listHomeFeedForUser(context.user.id, {
      cursor: data.cursor,
      limit: data.limit,
      tag: data.tag,
      q: data.q,
      filter: data.filter,
      visibility: data.visibility,
      favorited: data.favorited,
      from: data.from,
      to: data.to,
      tzOffsetMinutes: data.tzOffsetMinutes,
    }),
  )

export const updateMemo = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      id: z.string().min(1),
      content: z.string().trim().min(1).max(MAX_CONTENT),
    }),
  )
  .handler(async ({ data, context }) =>
    updateMemoForUser(context.user.id, data.id, data.content),
  )

export const deleteMemo = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data, context }) =>
    deleteMemoForUser(context.user.id, data.id),
  )

export const restoreDeletedMemo = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(({ data, context }) =>
    restoreDeletedMemoForUser(context.user.id, data.id),
  )

export const purgeMemo = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(({ data, context }) => purgeMemoForUser(context.user.id, data.id))

export const togglePin = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data, context }) =>
    togglePinForUser(context.user.id, data.id),
  )

export const toggleArchive = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data, context }) =>
    toggleArchiveForUser(context.user.id, data.id),
  )

export const setVisibility = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      id: z.string().min(1),
      visibility: z.enum(['public', 'private']),
    }),
  )
  .handler(async ({ data, context }) =>
    setVisibilityForUser(context.user.id, data.id, data.visibility),
  )

export const exportMemos = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.undefined())
  .handler(async ({ context }) => exportMemosForUser(context.user.id))

export const importMemos = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      // 单请求上限 2000 条（每条 ≤5000 字符 ≈ 10MB）：服务端函数在框架层
      // 先解析 JSON 再进入 handler，压降条目数可同时约束内存占用
      memos: z
        .array(
          z.object({
            id: z.string().min(1).optional(),
            content: z.string().trim().min(1).max(MAX_CONTENT),
            visibility: z.enum(['public', 'private']).default('private'),
            pinned: z.boolean().default(false),
            archived: z.boolean().default(false),
            createdAt: z.string().optional(),
            updatedAt: z.string().optional(),
            tags: z.array(z.string()).default([]),
          }),
        )
        .max(2000),
    }),
  )
  .handler(async ({ data, context }) => {
    // 导入是重事务操作（单次最多 2000 条），限制频率
    rateLimitOrThrow(`import-memos:${context.user.id}`, {
      window: 3600,
      max: 10,
      message: '导入过于频繁，请稍后再试',
    })
    return importMemosForUser(context.user.id, data.memos)
  })

export const getStats = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      tzOffsetMinutes: z.number().int().min(-840).max(840).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    getStatsForUser(context.user.id, data.tzOffsetMinutes),
  )

export const getContributionGraph = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional(),
      tzOffsetMinutes: z.number().int().min(-840).max(840).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    getContributionForUser(context.user.id, {
      month: data.month,
      tzOffsetMinutes: data.tzOffsetMinutes,
    }),
  )

export const getRandomMemos = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.object({ n: z.number().int().min(1).max(20).default(8) }))
  .handler(async ({ data, context }) =>
    getRandomMemosForUser(context.user.id, data.n),
  )

export const getMemoDetail = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const [memo, connections] = await Promise.all([
      getMemoForUser(context.user.id, data.id),
      getMemoConnectionsForUser(context.user.id, data.id),
    ])
    return { memo, connections }
  })

// 注意：此函数会写入回顾事件（副作用），必须用 POST，不能用 GET
export const getReviewMemos = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      mode: z.enum(['random', 'on-this-day', 'least-reviewed']),
      n: z.number().int().min(1).max(20).default(8),
      tag: z.string().max(200).optional(),
      tzOffsetMinutes: z.number().int().min(-840).max(840).optional(),
    }),
  )
  .handler(({ data, context }) => getReviewMemosForUser(context.user.id, data))

export const listMemoVersions = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.object({ memoId: z.string().min(1) }))
  .handler(({ data, context }) =>
    listMemoVersionsForUser(context.user.id, data.memoId),
  )

export const restoreMemoVersion = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      memoId: z.string().min(1),
      versionId: z.string().min(1),
    }),
  )
  .handler(({ data, context }) =>
    restoreMemoVersionForUser(context.user.id, data.memoId, data.versionId),
  )
