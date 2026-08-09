import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import {
  apiJson,
  corsResponse,
  handleApiError,
  readJsonBody,
  requireApiKey,
  validationError,
} from '#/server/api'
import {
  createMemoForUser,
  listMemosForUser,
  MAX_CONTENT,
} from '#/server/memos-core'

const createMemoSchema = z.object({
  content: z.string().trim().min(1).max(MAX_CONTENT),
  visibility: z.enum(['public', 'private']).default('private'),
  clientId: z.string().uuid().optional(),
})

const listMemosSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  tag: z.string().max(200).optional(),
  q: z.string().max(200).optional(),
  filter: z.enum(['all', 'archived', 'deleted']).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  favorited: z.coerce.boolean().optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  tzOffsetMinutes: z.coerce.number().int().min(-840).max(840).optional(),
})

export const Route = createFileRoute('/v1/memos')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const user = await requireApiKey(request)
          const url = new URL(request.url)
          const parsed = listMemosSchema.safeParse(
            Object.fromEntries(url.searchParams),
          )
          if (!parsed.success) return validationError(parsed.error)
          return apiJson(await listMemosForUser(user.id, parsed.data))
        } catch (error) {
          return handleApiError(error)
        }
      },
      POST: async ({ request }) => {
        try {
          const user = await requireApiKey(request)
          const parsed = createMemoSchema.safeParse(await readJsonBody(request))
          if (!parsed.success) return validationError(parsed.error)
          const clientId = z
            .string()
            .uuid()
            .optional()
            .safeParse(
              parsed.data.clientId ??
                request.headers.get('idempotency-key')?.trim() ??
                undefined,
            )
          if (!clientId.success) return validationError(clientId.error)
          const memo = await createMemoForUser(user.id, parsed.data.content, {
            visibility: parsed.data.visibility,
            clientId: clientId.data,
          })
          return apiJson(memo, { status: 201 })
        } catch (error) {
          return handleApiError(error)
        }
      },
      OPTIONS: () => corsResponse(),
    },
  },
})
