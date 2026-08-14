import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { authMiddleware } from './middleware'
import { rateLimitOrThrow } from './rate-limit'
import {
  addCommentForUser,
  assertMemoVisibleToUser,
  deleteCommentForUser,
  listCommentsForMemo,
  toggleFavoriteForUser,
  toggleLikeForUser,
  toggleRepostForUser,
  updateRepostForUser,
} from './interactions-core'
import { getSessionUserFromRequest } from './session-core'
import { listInteractionsForUser } from './timeline-core'

export const toggleLike = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ memoId: z.string().min(1) }))
  .handler(async ({ data, context }) =>
    toggleLikeForUser(context.user.id, data.memoId),
  )

export const toggleFavorite = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ memoId: z.string().min(1) }))
  .handler(async ({ data, context }) =>
    toggleFavoriteForUser(context.user.id, data.memoId),
  )

export const toggleRepost = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      memoId: z.string().min(1),
      content: z.string().trim().max(1000).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    toggleRepostForUser(context.user.id, data.memoId, data.content),
  )

export const updateRepost = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      memoId: z.string().min(1),
      content: z.string().trim().max(1000).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    updateRepostForUser(context.user.id, data.memoId, data.content),
  )

export const addComment = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      memoId: z.string().min(1),
      content: z.string().trim().min(1).max(2000),
    }),
  )
  .handler(async ({ data, context }) => {
    rateLimitOrThrow(`comment:${context.user.id}`, {
      window: 60,
      max: 30,
      message: '评论发送过于频繁，请稍后再试',
    })
    return addCommentForUser(context.user.id, data.memoId, data.content)
  })

export const deleteComment = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ commentId: z.string().min(1) }))
  .handler(async ({ data, context }) =>
    deleteCommentForUser(context.user.id, data.commentId),
  )

export const listComments = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      memoId: z.string().min(1),
      cursor: z.string().max(256).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
  )
  .handler(async ({ data }) => {
    const viewer = await getSessionUserFromRequest()
    const visible = await assertMemoVisibleToUser(
      data.memoId,
      viewer?.id ?? null,
    )
    if (!visible) {
      throw new Error('memo not found')
    }
    return listCommentsForMemo(data.memoId, {
      cursor: data.cursor,
      limit: data.limit,
    })
  })

/** 互动页：按类型分页返回当前用户互动过的 memo */
export const listInteractions = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      kind: z.enum(['likes', 'favorites', 'comments', 'reposts']),
      cursor: z.string().max(256).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
  )
  .handler(async ({ data, context }) =>
    listInteractionsForUser(context.user.id, data.kind, {
      cursor: data.cursor,
      limit: data.limit,
    }),
  )
