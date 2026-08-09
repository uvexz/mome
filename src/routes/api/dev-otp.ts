import { createFileRoute } from '@tanstack/react-router'
import { and, desc, eq, gt, like } from 'drizzle-orm'

import { db } from '#/db'
import { verification } from '#/db/schema'

/**
 * 开发环境专用：读取最近发送的 OTP（生产环境恒返回 404；
 * 且需显式设置 MOME_DEV_TOOLS=1，防止开发服务器误暴露到公网）。
 * 仅用于本地调试与 e2e，绝不部署到生产。
 */
export const Route = createFileRoute('/api/dev-otp')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (
          process.env.NODE_ENV === 'production' ||
          process.env.MOME_DEV_TOOLS !== '1'
        ) {
          return new Response('not found', { status: 404 })
        }
        const url = new URL(request.url)
        const email = url.searchParams.get('email')?.toLowerCase()
        const type = url.searchParams.get('type') ?? 'sign-in'
        if (!email) {
          return Response.json({ otp: null })
        }
        const identifier = `${type}-otp-${email}`
        if (type === 'change-email') {
          const row = await db.query.verification.findFirst({
            where: and(
              like(verification.identifier, `mome-change-email:%:${email}`),
              gt(verification.expiresAt, new Date()),
            ),
            orderBy: desc(verification.createdAt),
          })
          return Response.json({ otp: row?.value ?? null })
        }
        const row = await db.query.verification.findFirst({
          where: and(
            eq(verification.identifier, identifier),
            gt(verification.expiresAt, new Date()),
          ),
        })
        return Response.json({ otp: row?.value.split(':')[0] ?? null })
      },
    },
  },
})
