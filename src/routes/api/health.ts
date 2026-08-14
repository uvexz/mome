import { createFileRoute } from '@tanstack/react-router'
import { sql } from 'drizzle-orm'

import { db } from '#/db'

/**
 * 健康检查：验证服务与数据库可用（供 Docker HEALTHCHECK / 编排平台探活）。
 * 不返回任何敏感信息。
 */
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        try {
          await db.run(sql`SELECT 1`)
          return Response.json({ ok: true })
        } catch {
          return Response.json({ ok: false }, { status: 503 })
        }
      },
    },
  },
})
