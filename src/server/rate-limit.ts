import { getRequest } from '@tanstack/react-start/server'
import { AppError } from './error-shield'
import { eq, lt, sql } from 'drizzle-orm'

import { db } from '#/db'
import { rateLimitBuckets } from '#/db/schema'

export interface RateLimitOptions {
  window: number
  max: number
  message?: string
}

let lastSweep = 0

async function incrementBucket(key: string, window: number): Promise<number> {
  const now = Date.now()
  const resetAt = new Date(now + window * 1000)
  const [bucket] = await db
    .insert(rateLimitBuckets)
    .values({ key, count: 1, resetAt })
    .onConflictDoUpdate({
      target: rateLimitBuckets.key,
      set: {
        count: sql`CASE WHEN ${rateLimitBuckets.resetAt} <= ${now} THEN 1 ELSE ${rateLimitBuckets.count} + 1 END`,
        resetAt: sql`CASE WHEN ${rateLimitBuckets.resetAt} <= ${now} THEN ${resetAt.getTime()} ELSE ${rateLimitBuckets.resetAt} END`,
      },
    })
    .returning({ count: rateLimitBuckets.count })

  if (now - lastSweep >= 60_000) {
    lastSweep = now
    await db
      .delete(rateLimitBuckets)
      .where(lt(rateLimitBuckets.resetAt, new Date(now)))
  }
  return bucket.count
}

export async function rateLimitOrThrow(
  key: string,
  opts: RateLimitOptions,
): Promise<void> {
  if ((await incrementBucket(`limit:${key}`, opts.window)) > opts.max) {
    throw new AppError(opts.message ?? '请求过于频繁，请稍后再试')
  }
}

export async function recordFailure(
  key: string,
  max: number,
  ttlSeconds: number,
): Promise<boolean> {
  return (await incrementBucket(`failure:${key}`, ttlSeconds)) >= max
}

export async function clearFailures(key: string): Promise<void> {
  await db
    .delete(rateLimitBuckets)
    .where(eq(rateLimitBuckets.key, `failure:${key}`))
}

// 受信反向代理层数（MOME_TRUSTED_PROXY_COUNT）：决定取 X-Forwarded-For
// 从右往左第几个条目作为客户端 IP。
// - 1（默认）：单层代理（nginx / Cloudflare 等），最右侧条目由该代理写入；
// - 2+：多层代理依次左移；
// - 0：应用直接暴露，XFF 整体可伪造，忽略之（限流键退化为 'unknown'）。
const TRUSTED_PROXY_COUNT = (() => {
  const raw = Number(process.env.MOME_TRUSTED_PROXY_COUNT ?? '1')
  return Number.isInteger(raw) && raw >= 0 && raw <= 10 ? raw : 1
})()

export function clientIp(): string {
  try {
    if (TRUSTED_PROXY_COUNT === 0) return 'unknown'
    const request = getRequest()
    const forwarded = request.headers.get('x-forwarded-for')
    if (forwarded) {
      const entries = forwarded.split(',').map((part) => part.trim())
      // 从右往左第 N 个条目由第 N 层受信代理写入，其余（左侧）部分客户端可伪造
      const index = entries.length - TRUSTED_PROXY_COUNT
      if (index >= 0) {
        const ip = entries[index]
        if (ip && isValidIp(ip)) return ip
      }
    }
    // x-real-ip 由单层代理写入时即客户端真实 IP；多层代理下是内层代理地址，不可用
    if (TRUSTED_PROXY_COUNT === 1) {
      const realIp = request.headers.get('x-real-ip')?.trim()
      if (realIp && isValidIp(realIp)) return realIp
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

function isValidIp(value: string): boolean {
  if (value.length < 3 || value.length > 45) return false
  return /^[0-9a-fA-F:.%]+$/.test(value) && /[0-9a-fA-F]/.test(value)
}
