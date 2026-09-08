import { createFileRoute } from '@tanstack/react-router'

import { handleMemosCompat } from '#/server/memos-compat/handlers'

/**
 * usememos/memos v1 REST 兼容入口。
 *
 * 用单条 splat 路由 + 内部路由表分发：上游路径包含 `users:batchGet`、
 * `attachments:batchDelete` 这类冒号后缀段，用文件路由逐一表达既啰嗦又容易
 * 与参数段冲突。
 */
export const Route = createFileRoute('/api/v1/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleMemosCompat(request),
      POST: ({ request }) => handleMemosCompat(request),
      PATCH: ({ request }) => handleMemosCompat(request),
      PUT: ({ request }) => handleMemosCompat(request),
      DELETE: ({ request }) => handleMemosCompat(request),
      OPTIONS: ({ request }) => handleMemosCompat(request),
      HEAD: ({ request }) => handleMemosCompat(request),
    },
  },
})
