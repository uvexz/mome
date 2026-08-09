import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  listAllPublicMemos,
  getPublicMemoDetail,
  getPublicProfileByUsername,
  listPublicFeed,
} from './public-core'
import { getSessionUserFromRequest } from './session-core'

const usernameSchema = z
  .string()
  .min(1)
  .max(50)
  .transform((v) => v.toLowerCase())

async function viewerId(): Promise<string | null> {
  const viewer = await getSessionUserFromRequest()
  return viewer?.id ?? null
}

export const getPublicProfile = createServerFn({ method: 'GET' })
  .validator(z.object({ username: usernameSchema }))
  .handler(async ({ data }) => getPublicProfileByUsername(data.username))

export const listPublicMemos = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      username: usernameSchema,
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
  )
  .handler(async ({ data }) =>
    listPublicFeed(data.username, {
      cursor: data.cursor,
      limit: data.limit,
      viewerId: await viewerId(),
    }),
  )

export const getPublicMemo = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      username: usernameSchema,
      memoId: z.string().min(1),
    }),
  )
  .handler(async ({ data }) =>
    getPublicMemoDetail(data.username, data.memoId, await viewerId()),
  )

export const listPublicTimeline = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
      tag: z.string().max(100).optional(),
    }),
  )
  .handler(async ({ data }) =>
    listAllPublicMemos({
      cursor: data.cursor,
      limit: data.limit,
      viewerId: await viewerId(),
      tag: data.tag,
    }),
  )
