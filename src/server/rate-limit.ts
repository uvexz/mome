import { getRequest } from '@tanstack/react-start/server'
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
    throw new Error(opts.message ?? '请求过于频繁，请稍后再试')
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

function isValidIp(value: string): boolean {
  if (value.length < 3 || value.length > 45) return false
  return /^[0-9a-fA-F:.%]+$/.test(value) && /[0-9a-fA-F]/.test(value)
}
