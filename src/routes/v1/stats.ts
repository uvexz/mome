import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import {
  apiJson,
  corsResponse,
  handleApiError,
  methodNotAllowed,
  requireApiKey,
  validationError,
} from '#/server/api'
import { getStatsForUser } from '#/server/memos-core'

const statsSchema = z.object({
  tzOffsetMinutes: z.coerce.number().int().min(-840).max(840).optional(),
})

export const Route = createFileRoute('/v1/stats')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const user = await requireApiKey(request)
          const url = new URL(request.url)
          const parsed = statsSchema.safeParse(
            Object.fromEntries(url.searchParams),
          )
          if (!parsed.success) return validationError(parsed.error)
          return apiJson(
            await getStatsForUser(user.id, parsed.data.tzOffsetMinutes),
          )
        } catch (error) {
          return handleApiError(error)
        }
      },
      OPTIONS: () => corsResponse(),
      HEAD: () => methodNotAllowed(),
      POST: () => methodNotAllowed(),
      PUT: () => methodNotAllowed(),
      PATCH: () => methodNotAllowed(),
      DELETE: () => methodNotAllowed(),
    },
  },
})
