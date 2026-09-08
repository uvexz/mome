import { createServerFn } from '@tanstack/react-start'
import { AppError } from './error-shield'
import { z } from 'zod'

import { authMiddleware } from './middleware'
import {
  createApiKeyForUser,
  exchangeApiKeyForMemosPatForUser,
  listApiKeysForUser,
  revokeApiKeyForUser,
} from './api-keys-core'
import type { ApiKeyItem } from './api-keys-core'

export type { ApiKeyItem }

export const listApiKeys = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.undefined())
  .handler(async ({ context }): Promise<ApiKeyItem[]> =>
    listApiKeysForUser(context.user.id),
  )

export const createApiKey = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      name: z.string().trim().min(1).max(60),
      // ISO 8601 过期时间，可选
      expiresAt: z.string().datetime().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new AppError('过期时间必须晚于当前时间')
    }
    return createApiKeyForUser(context.user.id, data.name, { expiresAt })
  })

export const revokeApiKey = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    await revokeApiKeyForUser(context.user.id, data.id)
    return { success: true }
  })

/**
 * 用已有 API key 换取 Memos 兼容的 `memos_pat_` token。
 *
 * 需要粘贴自己的 key 是刻意的：既确认 key 归属当前账户，也让用户明确"换的是哪把 key"。
 * 明文 token 只在本次响应里出现一次。
 */
export const exchangeApiKeyForMemosPat = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      apiKey: z.string().trim().min(1).max(200),
      description: z.string().trim().max(60).optional(),
      // ISO 8601 过期时间，可选；缺省永不过期
      expiresAt: z.string().datetime().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    return exchangeApiKeyForMemosPatForUser(context.user.id, data.apiKey, {
      description: data.description,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
    })
  })
