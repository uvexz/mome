/**
 * Memos 兼容层响应与错误。
 *
 * 错误体遵循 usememos/memos（grpc-gateway）的 google.rpc.Status 形态：
 * `{ code, message, details }`，其中 code 为 gRPC 状态码而非 HTTP 状态码。
 */
import { CORS_HEADERS } from '../api'

/** gRPC 状态码子集（与 google.rpc.Code 数值一致） */
export const Code = {
  OK: 0,
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const

const HTTP_STATUS: Record<number, number> = {
  [Code.OK]: 200,
  [Code.INVALID_ARGUMENT]: 400,
  [Code.NOT_FOUND]: 404,
  [Code.ALREADY_EXISTS]: 409,
  [Code.PERMISSION_DENIED]: 403,
  [Code.RESOURCE_EXHAUSTED]: 429,
  [Code.FAILED_PRECONDITION]: 400,
  [Code.ABORTED]: 409,
  [Code.OUT_OF_RANGE]: 400,
  [Code.UNIMPLEMENTED]: 501,
  [Code.INTERNAL]: 500,
  [Code.UNAVAILABLE]: 503,
  [Code.UNAUTHENTICATED]: 401,
}

export class MemosError extends Error {
  constructor(
    public code: number,
    message: string,
    public httpStatus = HTTP_STATUS[code] ?? 500,
  ) {
    super(message)
    this.name = 'MemosError'
  }
}

export function notImplemented(what: string): MemosError {
  return new MemosError(Code.UNIMPLEMENTED, `${what} 在 Mome 上未实现`)
}

export function memosJson(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value)
  }
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(data), { ...init, headers })
}

export function memosErrorResponse(error: unknown): Response {
  if (error instanceof MemosError) {
    return memosJson(
      { code: error.code, message: error.message, details: [] },
      { status: error.httpStatus },
    )
  }
  console.error('[memos-compat] unexpected error', error)
  return memosJson(
    {
      code: Code.INTERNAL,
      message: '服务器内部错误',
      details: [],
    },
    { status: 500 },
  )
}

export function corsResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
