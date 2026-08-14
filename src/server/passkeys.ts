import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { authMiddleware } from './middleware'
import { clientIp, rateLimitOrThrow } from './rate-limit'
import {
  deletePasskeyForUser,
  generatePasskeyLoginOptions,
  generatePasskeyRegistrationOptions,
  listPasskeysForUser,
  verifyPasskeyLogin,
  verifyPasskeyRegistration,
} from './passkeys-core'

export const generatePasskeyRegistrationOptionsFn = createServerFn({
  method: 'GET',
})
  .middleware([authMiddleware])
  .validator(z.undefined())
  .handler(async ({ context }) =>
    generatePasskeyRegistrationOptions(
      context.user.id,
      context.user.username ?? context.user.email,
      context.user.name,
    ),
  )

export const verifyPasskeyRegistrationFn = createServerFn({
  method: 'POST',
})
  .middleware([authMiddleware])
  .validator(
    z.object({
      challengeId: z.string().min(1),
      name: z.string().max(50).default('Passkey'),
      response: z.unknown(),
    }),
  )
  .handler(async ({ data, context }) =>
    verifyPasskeyRegistration(
      context.user.id,
      data.name,
      data.challengeId,
      data.response as Parameters<typeof verifyPasskeyRegistration>[3],
    ),
  )

export const generatePasskeyLoginOptionsFn = createServerFn({
  method: 'GET',
})
  .validator(z.undefined())
  .handler(async () => {
    // 未认证入口：防 challenge 洪泛写库
    rateLimitOrThrow(`passkey:options:${clientIp()}`, { window: 60, max: 30 })
    return generatePasskeyLoginOptions()
  })

export const verifyPasskeyLoginFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      challengeId: z.string().min(1),
      response: z.unknown(),
    }),
  )
  .handler(async ({ data }) => {
    rateLimitOrThrow(`passkey:login:${clientIp()}`, { window: 60, max: 15 })
    return verifyPasskeyLogin(
      data.challengeId,
      data.response as Parameters<typeof verifyPasskeyLogin>[1],
    )
  })

export const listPasskeys = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.undefined())
  .handler(async ({ context }) => listPasskeysForUser(context.user.id))

export const deletePasskey = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ credentialId: z.string().min(1) }))
  .handler(async ({ data, context }) =>
    deletePasskeyForUser(context.user.id, data.credentialId),
  )
