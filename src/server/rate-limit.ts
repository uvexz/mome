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

/** 桶表容量上限：超出后淘汰最早插入的条目，防止伪造 key 造成内存膨胀 */
const MAX_BUCKETS = 20_000

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
    trimIfOversize(buckets)
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
  trimIfOversize(failures)
  return count >= max
}

/** 超过容量上限时按插入序淘汰最旧条目（Map 迭代序即插入序） */
function trimIfOversize(map: Map<string, Bucket>): void {
  if (map.size <= MAX_BUCKETS) return
  let excess = map.size - MAX_BUCKETS
  for (const key of map.keys()) {
    map.delete(key)
    if (--excess <= 0) break
  }
}

export function clearFailures(key: string): void {
  failures.delete(key)
}

/**
 * 当前请求的客户端 IP。
 * X-Forwarded-For 是逗号分隔的代理链列表，nginx 默认
 * `$proxy_add_x_forwarded_for` 会把真实客户端 IP 追加在列表末尾，
 * 而攻击者伪造的条目位于列表前部——因此必须从末跳向前取首个有效地址，
 * 不能取首跳（否则直连/追加模式下可伪造 XFF 绕过限流）。
 * 直连公网部署时请在反向代理层强制覆写 XFF（`X-Forwarded-For $remote_addr`）。
 */
export function clientIp(): string {
  try {
    const request = getRequest()
    const forwarded = request.headers.get('x-forwarded-for')
    if (forwarded) {
      const entries = forwarded.split(',').map((part) => part.trim())
      for (let i = entries.length - 1; i >= 0; i--) {
        const ip = entries[i]
        if (ip && isValidIp(ip)) return ip
      }
    }
    const realIp = request.headers.get('x-real-ip')?.trim()
    if (realIp && isValidIp(realIp)) return realIp
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 宽松校验 IP 字面量：仅接受合法字符与合理长度，避免伪造头污染限流表 */
function isValidIp(value: string): boolean {
  if (value.length < 3 || value.length > 45) return false
  return /^[0-9a-fA-F:.%]+$/.test(value) && /[0-9a-fA-F]/.test(value)
}
