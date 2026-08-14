import { createFileRoute } from '@tanstack/react-router'
import { and, desc, eq, gt, like } from 'drizzle-orm'

import { db } from '#/db'
import { verification } from '#/db/schema'

/**
 * 开发环境专用：读取最近发送的 OTP。
 * 门控为 fail-closed：必须显式 `NODE_ENV === 'development'` 且
 * `MOME_DEV_TOOLS === '1'` 才可用；production/staging/未设置一律 404，
 * 防止部署环境漏设 NODE_ENV 时误暴露到公网。
 * 仅用于本地调试，绝不部署到生产。
 */
const DEV_OTP_ENABLED =
  process.env.NODE_ENV === 'development' && process.env.MOME_DEV_TOOLS === '1'

export const Route = createFileRoute('/api/dev-otp')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!DEV_OTP_ENABLED) {
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
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            return Response.json({ otp: null })
          }
          // 换邮箱 OTP 的 identifier 形如 mome-change-email:<userId>:<email>，
          // userId 未知，按固定前缀取最近记录后在应用侧精确比对邮箱后缀，
          // 避免把用户输入拼进 LIKE 造成通配符跨用户匹配
          const rows = await db.query.verification.findMany({
            where: and(
              like(verification.identifier, 'mome-change-email:%'),
              gt(verification.expiresAt, new Date()),
            ),
            orderBy: desc(verification.createdAt),
            limit: 50,
          })
          const row = rows.find((r) => r.identifier.endsWith(`:${email}`))
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
