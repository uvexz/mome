import { createFileRoute } from '@tanstack/react-router'

import {
  apiJson,
  corsResponse,
  handleApiError,
  requireApiKey,
} from '#/server/api'
import { listTagsForUser } from '#/server/tags-core'

export const Route = createFileRoute('/v1/tags')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const user = await requireApiKey(request)
          return apiJson(await listTagsForUser(user.id))
        } catch (error) {
          return handleApiError(error)
        }
      },
      OPTIONS: () => corsResponse(),
    },
  },
})
