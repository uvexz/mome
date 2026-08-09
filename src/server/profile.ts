import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { and, eq, gt, like, or } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '#/db'
import { user, verification } from '#/db/schema'
import { auth } from '#/lib/auth'
import { sendOtpEmail } from '#/lib/email'
import { ulid } from '#/lib/ulid'

import { authMiddleware } from './middleware'
import { listPasskeysForUser } from './passkeys-core'
import { clearFailures, rateLimitOrThrow, recordFailure } from './rate-limit'
import { loadEmailSettings } from './settings-core'

/** 当前用户资料 + passkey 列表（设置页用） */
export const getMyProfile = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
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

/**
 * 开发环境专用：读取刚发送的 OTP（仅 NODE_ENV !== production）。
 * 生产环境返回 null，保证不会泄露验证码。
 */
export const devGetOtp = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      email: z.string().email(),
      type: z.enum([
        'sign-in',
        'email-verification',
        'forget-password',
        'change-email',
      ]),
    }),
  )
  .handler(async ({ data }) => {
    if (
      process.env.NODE_ENV === 'production' ||
      process.env.MOME_DEV_TOOLS !== '1'
    )
      return null
    const identifier = `${data.type}-otp-${data.email.toLowerCase()}`
    const row = await db.query.verification.findFirst({
      where: and(
        eq(verification.identifier, identifier),
        gt(verification.expiresAt, new Date()),
      ),
    })
    if (!row) return null
    return row.value.split(':')[0] ?? null
  })

// ── 更换邮箱（当前密码 + 新邮箱 OTP） ────────────────────
const EMAIL_CHANGE_TTL_MS = 5 * 60 * 1000

function emailChangeIdentifier(userId: string, email: string): string {
  return `mome-change-email:${userId}:${email.toLowerCase()}`
}

function generateOtp(): string {
  const value = crypto.getRandomValues(new Uint32Array(1))[0]
  return String(value % 1_000_000).padStart(6, '0')
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
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
    rateLimitOrThrow(`email-change:req:${context.user.id}`, {
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

    // 2. 生成新邮箱 OTP
    const identifier = emailChangeIdentifier(context.user.id, email)
    const otp = generateOtp()
    await db.delete(verification).where(eq(verification.identifier, identifier))
    await db.insert(verification).values({
      id: ulid(),
      identifier,
      value: otp,
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
    rateLimitOrThrow(`email-change:confirm:${context.user.id}`, {
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
    const failKey = `email-change:otp:${identifier}`
    if (!safeEqual(row.value, data.otp)) {
      if (recordFailure(failKey, 5, 600)) {
        await db.delete(verification).where(eq(verification.id, row.id))
        clearFailures(failKey)
        throw new Error('验证码错误次数过多，请重新获取验证码')
      }
      throw new Error('验证码不正确')
    }
    clearFailures(failKey)
    await db.delete(verification).where(eq(verification.id, row.id))

    const authCtx = await auth.$context
    await authCtx.internalAdapter.updateUser(context.user.id, {
      email,
      emailVerified: true,
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
    const request = getRequest()
    try {
      await auth.api.verifyPassword({
        body: { password: data.password },
        headers: request.headers,
      })
    } catch {
      throw new Error('当前密码不正确')
    }

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
