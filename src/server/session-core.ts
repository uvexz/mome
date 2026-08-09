import { getRequest } from '@tanstack/react-start/server'

import { auth } from '#/lib/auth'

import type { AuthUser } from './middleware'

/**
 * 从当前请求中解析会话用户；未登录返回 null。
 * 仅供 server function 内部复用（不要被客户端路由直接 import）。
 */
export async function getSessionUserFromRequest(): Promise<AuthUser | null> {
  const request = getRequest()
  const session = await auth.api.getSession({
    headers: request.headers,
  })
  return session?.user ?? null
}
