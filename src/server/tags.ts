import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { authMiddleware } from './middleware'
import { listTagsForUser } from './tags-core'
import type { TagWithCount } from './tags-core'

export type { TagWithCount }

export const listTags = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.undefined())
  .handler(async ({ context }) => listTagsForUser(context.user.id))
