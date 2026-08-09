import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { authMiddleware } from './middleware'
import {
  countUnreadNotificationsForUser,
  listNotificationsForUser,
  markNotificationsReadForUser,
} from './notifications-core'

export type { NotificationItem, NotificationType } from './notifications-core'

export const listNotifications = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
  )
  .handler(({ data, context }) =>
    listNotificationsForUser(context.user.id, data),
  )

export const getUnreadNotificationCount = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => ({
    count: await countUnreadNotificationsForUser(context.user.id),
  }))

export const markNotificationsRead = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ all: z.literal(true) }))
  .handler(async ({ context }) => {
    await markNotificationsReadForUser(context.user.id)
    return { ok: true }
  })
