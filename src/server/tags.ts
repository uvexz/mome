import { createServerFn } from '@tanstack/react-start'

import { authMiddleware } from './middleware'
import { listTagsForUser } from './tags-core'
import type { TagWithCount } from './tags-core'

export type { TagWithCount }

export const listTags = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => listTagsForUser(context.user.id))
