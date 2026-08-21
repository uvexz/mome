import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import {
  ApiError,
  apiError,
  apiJson,
  corsResponse,
  handleApiError,
  methodNotAllowed,
  readJsonBody,
  requireApiKey,
  validationError,
} from '#/server/api'
import {
  deleteMemoForUser,
  getMemoForUser,
  MAX_CONTENT,
  patchMemoForUser,
} from '#/server/memos-core'

const updateMemoSchema = z
  .object({
    content: z.string().trim().min(1).max(MAX_CONTENT).optional(),
    visibility: z.enum(['public', 'private']).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.content !== undefined ||
      value.visibility !== undefined ||
      value.pinned !== undefined ||
      value.archived !== undefined,
    {
      message: '至少提供 content / visibility / pinned / archived 中的一个字段',
    },
  )

export const Route = createFileRoute('/v1/memos/$memoId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const user = await requireApiKey(request)
          try {
            return apiJson(await getMemoForUser(user.id, params.memoId))
          } catch (error) {
            if (error instanceof Error && error.message === 'memo not found') {
              throw new ApiError('memo_not_found', 'memo 不存在', 404)
            }
            throw error
          }
        } catch (error) {
          return handleApiError(error)
        }
      },
      PATCH: async ({ request, params }) => {
        try {
          const user = await requireApiKey(request)
          const parsed = updateMemoSchema.safeParse(await readJsonBody(request))
          if (!parsed.success) return validationError(parsed.error)
          try {
            return apiJson(
              await patchMemoForUser(user.id, params.memoId, parsed.data),
            )
          } catch (error) {
            if (error instanceof Error && error.message === 'memo not found') {
              throw new ApiError('memo_not_found', 'memo 不存在', 404)
            }
            throw error
          }
        } catch (error) {
          return handleApiError(error)
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          const user = await requireApiKey(request)
          const res = await deleteMemoForUser(user.id, params.memoId)
          if (!res.deleted) {
            return apiError('memo_not_found', 'memo 不存在', 404)
          }
          return apiJson({ deleted: true })
        } catch (error) {
          return handleApiError(error)
        }
      },
      OPTIONS: () => corsResponse(),
      HEAD: () => methodNotAllowed(),
      POST: () => methodNotAllowed(),
      PUT: () => methodNotAllowed(),
    },
  },
})
