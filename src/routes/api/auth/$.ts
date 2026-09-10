import { createFileRoute } from '@tanstack/react-router'

import { auth } from '#/lib/auth'
import { isPasswordLoginBlocked } from '#/server/auth-policy'
import { revokeRefreshTokensForUser } from '#/server/memos-compat/auth'
import { loadEmailSettings, loadSiteSettings } from '#/server/settings-core'

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
      POST: async ({ request }) => {
        const path = new URL(request.url).pathname
        const site = await loadSiteSettings()

        // 管理员关闭公开注册后，注册接口直接拒绝
        if (path.endsWith('/sign-up/email') && !site.allowSignup) {
          return Response.json(
            { error: { message: '站点已关闭公开注册' } },
            { status: 403 },
          )
        }

        // 邮件服务可用时
        const emailSettings = await loadEmailSettings()

        // 注册成功后不直接持有会话（better-auth 默认注册即登录）：吊销会话并剥离 Set-Cookie，
        // 用户需先完成邮箱 OTP 验证再登录
        if (path.endsWith('/sign-up/email') && emailSettings.enabled) {
          return signUpWithoutSession(request)
        }

        // 密码登录前要求已验证邮箱（运行时配置即时生效）。
        // email 与 username 两个入口用同一策略，不能只守其中一个。
        const isPasswordSignIn =
          path.endsWith('/sign-in/email') || path.endsWith('/sign-in/username')
        if (!isPasswordSignIn) {
          return withCompatRevocation(path, request)
        }

        const text = await request.text()
        const body = parseBody(text)
        const blocked = await isPasswordLoginBlocked({
          email: typeof body.email === 'string' ? body.email : undefined,
          username:
            typeof body.username === 'string' ? body.username : undefined,
        })
        if (blocked) {
          // 与 better-auth 对未知邮箱的响应完全一致（401 + 同文案同结构），
          // 防止通过差异响应枚举"已注册但未验证"的邮箱
          return Response.json(
            {
              message: 'Invalid email or password',
              code: 'INVALID_EMAIL_OR_PASSWORD',
            },
            { status: 401 },
          )
        }
        return auth.handler(
          new Request(request.url, {
            method: 'POST',
            headers: request.headers,
            body: text,
          }),
        )
      },
    },
  },
})

/**
 * 退出与改密必须同时让 Memos 兼容层的 refresh 凭据失效，
 * 否则删掉浏览器会话后旧 refresh token 仍能继续换取访问令牌。
 */
async function withCompatRevocation(
  path: string,
  request: Request,
): Promise<Response> {
  const revokes =
    path.endsWith('/sign-out') ||
    path.endsWith('/change-password') ||
    path.endsWith('/revoke-sessions') ||
    path.endsWith('/revoke-other-sessions')
  const userId = revokes
    ? await auth.api
        .getSession({ headers: request.headers })
        .then((session) => session?.user.id ?? null)
        .catch(() => null)
    : null
  const response = await auth.handler(request)
  if (userId && response.status < 400) {
    await revokeRefreshTokensForUser(userId)
  }
  return response
}

function parseBody(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return Object.fromEntries(new URLSearchParams(text))
  }
}

/**
 * 转发注册请求，但对成功的注册吊销其自动签发的会话：
 * 从响应体提取 session token 删除服务端会话，并从响应剔除 Set-Cookie。
 */
async function signUpWithoutSession(request: Request): Promise<Response> {
  const response = await auth.handler(request)
  if (response.status >= 400) return response

  const text = await response.text()
  let body: { token?: string; user?: { emailVerified?: boolean } } | null = null
  try {
    body = JSON.parse(text)
  } catch {
    // 非 JSON 响应（异常情形），原样返回
    return new Response(text, {
      status: response.status,
      headers: response.headers,
    })
  }

  const headers = new Headers(response.headers)
  if (!body?.token || body.user?.emailVerified !== false) {
    return new Response(text, { status: response.status, headers })
  }

  try {
    const authCtx = await auth.$context
    await authCtx.internalAdapter.deleteSession(body.token)
  } catch (err) {
    console.error('[auth] 注册会话吊销失败', err)
    return Response.json(
      { error: { message: '注册暂时无法完成，请稍后重试' } },
      { status: 500 },
    )
  }
  headers.delete('set-cookie')
  return new Response(text, { status: response.status, headers })
}
