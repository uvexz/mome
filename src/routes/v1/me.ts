import { createFileRoute } from '@tanstack/react-router'

import {
  apiJson,
  corsResponse,
  handleApiError,
  requireApiKey,
} from '#/server/api'

export const Route = createFileRoute('/v1/me')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          return apiJson(await requireApiKey(request))
        } catch (error) {
          return handleApiError(error)
        }
      },
      OPTIONS: () => corsResponse(),
    },
  },
})
