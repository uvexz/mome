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
  getStatsForUser,
  importMemosForUser,
  listMemosForUser,
  MAX_CONTENT,
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

export const createMemo = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      content: z.string().trim().min(1).max(MAX_CONTENT),
      visibility: z.enum(['public', 'private']).default('private'),
    }),
  )
  .handler(async ({ data, context }) =>
    createMemoForUser(context.user.id, data.content, {
      visibility: data.visibility,
    }),
  )

export const listMemos = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
      tag: z.string().optional(),
      q: z.string().max(200).optional(),
      filter: z.enum(['all', 'archived']).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    listMemosForUser(context.user.id, {
      cursor: data.cursor,
      limit: data.limit,
      tag: data.tag,
      q: data.q,
      filter: data.filter,
    }),
  )

/** 个人时间线：自己的 memo + 转发的他人公开 memo */
export const listHomeFeed = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
      tag: z.string().optional(),
      q: z.string().max(200).optional(),
      filter: z.enum(['all', 'archived']).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    listHomeFeedForUser(context.user.id, {
      cursor: data.cursor,
      limit: data.limit,
      tag: data.tag,
      q: data.q,
      filter: data.filter,
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
  .handler(async ({ context }) => exportMemosForUser(context.user.id))

export const importMemos = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
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
        .max(5000),
    }),
  )
  .handler(async ({ data, context }) => {
    // 导入是重事务操作（单次最多 5000 条），限制频率
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
