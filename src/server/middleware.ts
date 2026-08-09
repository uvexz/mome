import { createMiddleware } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { redirect } from '@tanstack/react-router'

import { auth } from '#/lib/auth'

import { isAdminUser } from './settings-core'

/**
 * server function 认证中间件：未登录直接重定向到 /login。
 * 通过 `context.user` 向 handler 注入当前用户。
 */
export const authMiddleware = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    const request = getRequest()
    const session = await auth.api.getSession({
      headers: request.headers,
    })

    if (!session) {
      throw redirect({ to: '/login' })
    }

    return next({ context: { user: session.user } })
  },
)

/** 管理员 server function 中间件：未登录跳登录页，非管理员直接报错 */
export const adminMiddleware = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    const request = getRequest()
    const session = await auth.api.getSession({
      headers: request.headers,
    })

    if (!session) {
      throw redirect({ to: '/login' })
    }
    if (!(await isAdminUser(session.user.id))) {
      throw new Error('需要管理员权限')
    }

    return next({ context: { user: session.user } })
  },
)

export type AuthUser =
  Awaited<ReturnType<typeof auth.api.getSession>> extends infer T
    ? T extends { user: infer U }
      ? U
      : never
    : never
