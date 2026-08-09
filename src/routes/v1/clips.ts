import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { buildWebClipContent, normalizeClipTag } from '#/lib/web-clip'
import {
  ApiError,
  apiJson,
  corsResponse,
  handleApiError,
  readJsonBody,
  requireApiKey,
  validationError,
} from '#/server/api'
import { createMemoForUser, MAX_CONTENT } from '#/server/memos-core'

const clipTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => normalizeClipTag(value) !== null, '标签格式不合法')
  .transform((value) => normalizeClipTag(value)!)

const createClipSchema = z.object({
  title: z.string().trim().max(500).default(''),
  url: z.string().trim().url().max(2048),
  description: z.string().trim().max(1500).default(''),
  content: z.string().trim().max(4000).default(''),
  tags: z.array(clipTagSchema).max(20).default([]),
  visibility: z.enum(['public', 'private']).default('private'),
  clientId: z.string().uuid().optional(),
})

export const Route = createFileRoute('/v1/clips')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const user = await requireApiKey(request)
          const parsed = createClipSchema.safeParse(await readJsonBody(request))
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

          const content = buildWebClipContent(parsed.data)
          if (content.length > MAX_CONTENT) {
            throw new ApiError(
              'content_too_long',
              `剪藏内容不能超过 ${MAX_CONTENT} 个字符`,
            )
          }
          const memo = await createMemoForUser(user.id, content, {
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
