import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { authMiddleware } from './middleware'
import {
  createApiKeyForUser,
  listApiKeysForUser,
  revokeApiKeyForUser,
} from './api-keys-core'
import type { ApiKeyItem } from './api-keys-core'

export type { ApiKeyItem }

export const listApiKeys = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
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
      throw new Error('过期时间必须晚于当前时间')
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
