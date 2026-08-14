import type { ZodError } from 'zod'

import { clientIp, rateLimitOrThrow } from './rate-limit'
import { authenticateApiKeyToken } from './api-keys-core'
import type { ApiKeyUser } from './api-keys-core'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Idempotency-Key',
  'Access-Control-Max-Age': '86400',
}

/** v1 请求体上限：写操作最大约 5KB 文本，1MB 已远大于实际需求 */
export const MAX_BODY_BYTES = 1_048_576

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function apiJson(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value)
  }
  headers.set('Content-Type', 'application/json; charset=utf-8')
  // 响应含私有数据且鉴权头为 Authorization：禁止任何共享缓存存储
  headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(data), { ...init, headers })
}

export function apiError(
  code: string,
  message: string,
  status = 400,
): Response {
  return apiJson({ error: { code, message } }, { status })
}

/** v1 端点未实现的方法统一返回 405 JSON（否则会落到路由渲染返回 200 HTML） */
export function methodNotAllowed(): Response {
  return apiError('method_not_allowed', '请求方法不支持', 405)
}

export function handleApiError(error: unknown): Response {
  if (error instanceof ApiError) {
    return apiError(error.code, error.message, error.status)
  }
  console.error('[api] unexpected error', error)
  return apiError('internal_error', '服务器内部错误', 500)
}

export function corsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  })
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : null
}

/** 限流异常转 429（rateLimitOrThrow 抛的是普通 Error） */
function rateLimit(key: string, opts: { window: number; max: number }): void {
  try {
    rateLimitOrThrow(key, opts)
  } catch (error) {
    throw new ApiError(
      'rate_limited',
      error instanceof Error ? error.message : '请求过于频繁',
      429,
    )
  }
}

export async function requireApiKey(request: Request): Promise<ApiKeyUser> {
  const ip = clientIp()
  const token = bearerToken(request)
  if (!token) {
    // 缺失/无效凭据按 IP 限流（防枚举与 DB 压力）
    rateLimit(`v1:auth-fail:${ip}`, { window: 60, max: 30 })
    throw new ApiError(
      'unauthorized',
      '缺少 Authorization 头，请使用 Bearer <API key>',
      401,
    )
  }
  const apiUser = await authenticateApiKeyToken(token)
  if (!apiUser) {
    rateLimit(`v1:auth-fail:${ip}`, { window: 60, max: 30 })
    throw new ApiError('invalid_api_key', 'API key 无效、已过期或已撤销', 401)
  }
  // 有效 key 按方法限流（读 120/分、写 60/分），防止 key 泄漏后被无限滥用
  const isWrite = request.method !== 'GET' && request.method !== 'HEAD'
  rateLimit(`v1:key:${apiUser.id}:${isWrite ? 'write' : 'read'}`, {
    window: 60,
    max: isWrite ? 60 : 120,
  })
  return apiUser
}

export async function readJsonBody(request: Request): Promise<unknown> {
  // 解析前先按声明长度拦截，避免超大 body 进入内存
  const declared = request.headers.get('content-length')
  if (declared) {
    const size = Number(declared)
    if (!Number.isFinite(size) || size > MAX_BODY_BYTES) {
      throw new ApiError('payload_too_large', '请求体过大', 413)
    }
  }
  try {
    const text = await readBodyWithLimit(request, MAX_BODY_BYTES)
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('invalid_json', '请求体不是合法的 JSON', 400)
  }
}

/** 流式读取 body 并强制字节上限（覆盖 chunked 无 Content-Length 的情况） */
async function readBodyWithLimit(
  request: Request,
  max: number,
): Promise<string> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new ApiError('payload_too_large', '请求体过大', 413)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function validationError(error: ZodError): Response {
  const message = error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ')
  return apiError('validation_error', message, 400)
}
