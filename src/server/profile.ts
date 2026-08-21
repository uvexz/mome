import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { and, eq, gt, like, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '#/db'
import { user, verification } from '#/db/schema'
import { auth } from '#/lib/auth'
import { sendOtpEmail } from '#/lib/email'
import { ulid } from '#/lib/ulid'

import { authMiddleware } from './middleware'
import { listPasskeysForUser } from './passkeys-core'
import {
  clearFailures,
  clientIp,
  rateLimitOrThrow,
  recordFailure,
} from './rate-limit'
import { loadEmailSettings } from './settings-core'

/** 当前用户资料 + passkey 列表（设置页用） */
export const getMyProfile = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.undefined())
  .handler(async ({ context }) => ({
    user: {
      id: context.user.id,
      name: context.user.name,
      email: context.user.email,
      username: context.user.username,
      bio: context.user.bio ?? null,
      image: context.user.image ?? null,
      emailVerified: context.user.emailVerified,
    },
    passkeys: await listPasskeysForUser(context.user.id),
  }))

// ── 更换邮箱（当前密码 + 新邮箱 OTP） ────────────────────
const EMAIL_CHANGE_TTL_MS = 5 * 60 * 1000

function emailChangeIdentifier(userId: string, email: string): string {
  return `mome-change-email:${userId}:${email.toLowerCase()}`
}

function generateOtp(): string {
  // randomInt 无模偏差（避免 % 1_000_000 造成的 0.023% 分布偏斜）
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** OTP 落库前加盐哈希，避免数据库/备份泄露即拿到可用验证码 */
function hashOtp(otp: string): string {
  return createHash('sha256').update(`mome-otp:${otp}`).digest('hex')
}

export const requestEmailChange = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      newEmail: z.string().email(),
      password: z.string().min(1).max(128),
    }),
  )
  .handler(async ({ data, context }) => {
    await rateLimitOrThrow(`email-change:req:${context.user.id}`, {
      window: 300,
      max: 3,
      message: '验证码发送过于频繁，请 5 分钟后再试',
    })
    const emailSettings = await loadEmailSettings()
    if (!emailSettings.enabled) {
      throw new Error('邮件服务未配置，无法更换邮箱')
    }
    // 1. 校验当前密码
    const request = getRequest()
    try {
      await auth.api.verifyPassword({
        body: { password: data.password },
        headers: request.headers,
      })
    } catch (err) {
      console.error('[email-change] verifyPassword failed', err)
      throw new Error('当前密码不正确')
    }

    const email = data.newEmail.toLowerCase()
    const existing = await db.query.user.findFirst({
      where: eq(user.email, email),
      columns: { id: true },
    })
    if (existing) throw new Error('该邮箱已被使用')

    // 2. 生成新邮箱 OTP（只存哈希）
    const identifier = emailChangeIdentifier(context.user.id, email)
    const otp = generateOtp()
    await db.delete(verification).where(eq(verification.identifier, identifier))
    await db.insert(verification).values({
      id: ulid(),
      identifier,
      value: hashOtp(otp),
      expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await sendOtpEmail({ email, otp, type: 'change-email' })
    return { success: true }
  })

export const confirmEmailChange = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      newEmail: z.string().email(),
      otp: z.string().regex(/^\d{6}$/),
    }),
  )
  .handler(async ({ data, context }) => {
    await rateLimitOrThrow(`email-change:confirm:${context.user.id}`, {
      window: 60,
      max: 15,
      message: '尝试过于频繁，请稍后再试',
    })
    const emailSettings = await loadEmailSettings()
    if (!emailSettings.enabled) {
      throw new Error('邮件服务未配置，无法更换邮箱')
    }
    const email = data.newEmail.toLowerCase()
    const identifier = emailChangeIdentifier(context.user.id, email)
    const row = await db.query.verification.findFirst({
      where: and(
        eq(verification.identifier, identifier),
        gt(verification.expiresAt, new Date()),
      ),
    })
    if (!row) throw new Error('验证码无效或已过期')
    // 错误 5 次即作废当前 OTP，需重新请求
    if (!safeEqual(row.value, hashOtp(data.otp))) {
      const attempts = await db.transaction(async (tx) => {
        const updated = await tx
          .update(verification)
          .set({
            attempts: sql`${verification.attempts} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(verification.id, row.id))
          .returning({ attempts: verification.attempts })
        const count = updated[0]?.attempts ?? 5
        if (count >= 5) {
          await tx.delete(verification).where(eq(verification.id, row.id))
        }
        return count
      })
      if (attempts >= 5) {
        throw new Error('验证码错误次数过多，请重新获取验证码')
      }
      throw new Error('验证码不正确')
    }
    await db.transaction(async (tx) => {
      const consumed = await tx
        .delete(verification)
        .where(
          and(
            eq(verification.id, row.id),
            eq(verification.value, hashOtp(data.otp)),
            gt(verification.expiresAt, new Date()),
          ),
        )
        .returning({ id: verification.id })
      if (consumed.length !== 1) throw new Error('验证码无效或已过期')
      await tx
        .update(user)
        .set({ email, emailVerified: true, updatedAt: new Date() })
        .where(eq(user.id, context.user.id))
    })
    return { success: true, email }
  })

// ── 注销账号（硬删除 + 清理残留） ────────────────────────
/**
 * 自定义注销：校验当前密码后硬删除用户并清理所有残留记录，
 * 确保同一邮箱可立即重新注册。
 */
export const deleteAccount = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ password: z.string().min(1).max(128) }))
  .handler(async ({ data, context }) => {
    // 防密码在线爆破（此路径此前完全无节流）
    await rateLimitOrThrow(`delete-account:${context.user.id}:${clientIp()}`, {
      window: 60,
      max: 5,
      message: '尝试过于频繁，请稍后再试',
    })
    const request = getRequest()
    try {
      await auth.api.verifyPassword({
        body: { password: data.password },
        headers: request.headers,
      })
    } catch {
      // 连续失败 15 次熔断 15 分钟，要求等待后重试
      if (
        await recordFailure(`delete-account:fail:${context.user.id}`, 15, 900)
      ) {
        throw new Error('尝试次数过多，请 15 分钟后再试')
      }
      throw new Error('当前密码不正确')
    }
    await clearFailures(`delete-account:fail:${context.user.id}`)

    const authCtx = await auth.$context
    const userId = context.user.id
    const email = context.user.email.toLowerCase()

    // 清理该用户可能残留的验证记录（OTP / 换邮箱 / passkey 注册挑战）
    await db
      .delete(verification)
      .where(
        or(
          eq(verification.identifier, `email-verification-otp-${email}`),
          eq(verification.identifier, `sign-in-otp-${email}`),
          like(verification.identifier, `mome-change-email:${userId}:%`),
          like(verification.identifier, `passkey-register:${userId}:%`),
        ),
      )
    // 硬删除用户（关联表由 FK 级联清理）
    await authCtx.internalAdapter.deleteUser(userId)
    await authCtx.internalAdapter.deleteUserSessions(userId)
    return { success: true }
  })
