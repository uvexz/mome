import { createFileRoute } from '@tanstack/react-router'

import {
  apiJson,
  corsResponse,
  handleApiError,
  methodNotAllowed,
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
      HEAD: () => methodNotAllowed(),
      POST: () => methodNotAllowed(),
      PUT: () => methodNotAllowed(),
      PATCH: () => methodNotAllowed(),
      DELETE: () => methodNotAllowed(),
    },
  },
})
