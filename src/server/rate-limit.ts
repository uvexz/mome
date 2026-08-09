import { getRequest } from '@tanstack/react-start/server'

/**
 * 轻量内存限流（固定窗口）+ 失败计数熔断。
 * 适用于单实例部署；多实例部署应替换为 Redis 等共享存储。
 */

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()
const failures = new Map<string, Bucket>()

const SWEEP_INTERVAL_MS = 60_000
let lastSweep = Date.now()

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return
  lastSweep = now
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
  for (const [key, bucket] of failures) {
    if (bucket.resetAt <= now) failures.delete(key)
  }
}

export interface RateLimitOptions {
  /** 窗口长度（秒） */
  window: number
  /** 窗口内最大请求数 */
  max: number
  /** 触发限流时的错误信息 */
  message?: string
}

/** 固定窗口限流；超限抛错 */
export function rateLimitOrThrow(key: string, opts: RateLimitOptions): void {
  const now = Date.now()
  sweep(now)
  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + opts.window * 1000 })
    return
  }
  bucket.count += 1
  if (bucket.count > opts.max) {
    throw new Error(opts.message ?? '请求过于频繁，请稍后再试')
  }
}

/**
 * 记录一次失败；返回是否达到上限（>= max）。
 * 用于 OTP 等敏感凭证的失败熔断（达到上限后调用方应作废凭证）。
 */
export function recordFailure(
  key: string,
  max: number,
  ttlSeconds: number,
): boolean {
  const now = Date.now()
  const bucket = failures.get(key)
  const count = !bucket || bucket.resetAt <= now ? 1 : bucket.count + 1
  failures.set(key, { count, resetAt: now + ttlSeconds * 1000 })
  return count >= max
}

export function clearFailures(key: string): void {
  failures.delete(key)
}

/** 当前请求的客户端 IP（经反向代理时取 X-Forwarded-For 首跳） */
export function clientIp(): string {
  try {
    const request = getRequest()
    const forwarded = request.headers.get('x-forwarded-for')
    if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown'
    return request.headers.get('x-real-ip') ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
