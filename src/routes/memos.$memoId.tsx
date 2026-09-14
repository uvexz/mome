import { createFileRoute, notFound, redirect } from '@tanstack/react-router'

import { resolveMemoPermalink } from '#/server/public'

/**
 * Memos 兼容面的 memo 永久链接别名。
 *
 * 第三方 Memos 客户端（web-clipper、脚本等）只知道 `memos/{id}`，会拼
 * `${instanceUrl}/memos/{id}`；Mome 的详情页在 `/@{username}/{id}`。
 * 这里解析出作者后重定向，可读性判定与公开详情页一致（非公开只对作者放行）。
 */
export const Route = createFileRoute('/memos/$memoId')({
  beforeLoad: async ({ params }) => {
    const permalink = await resolveMemoPermalink({
      data: { memoId: params.memoId },
    })
    if (!permalink) throw notFound()
    throw redirect({
      to: '/@{$username}/$memoId',
      params: { username: permalink.username, memoId: params.memoId },
      replace: true,
    })
  },
})
