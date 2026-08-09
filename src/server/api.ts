import type { ZodError } from 'zod'

import { authenticateApiKeyToken } from './api-keys-core'
import type { ApiKeyUser } from './api-keys-core'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
}

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
  return new Response(JSON.stringify(data), { ...init, headers })
}

export function apiError(
  code: string,
  message: string,
  status = 400,
): Response {
  return apiJson({ error: { code, message } }, { status })
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

export async function requireApiKey(request: Request): Promise<ApiKeyUser> {
  const token = bearerToken(request)
  if (!token) {
    throw new ApiError(
      'unauthorized',
      '缺少 Authorization 头，请使用 Bearer <API key>',
      401,
    )
  }
  const apiUser = await authenticateApiKeyToken(token)
  if (!apiUser) {
    throw new ApiError('invalid_api_key', 'API key 无效、已过期或已撤销', 401)
  }
  return apiUser
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new ApiError('invalid_json', '请求体不是合法的 JSON', 400)
  }
}

export function validationError(error: ZodError): Response {
  const message = error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ')
  return apiError('validation_error', message, 400)
}
