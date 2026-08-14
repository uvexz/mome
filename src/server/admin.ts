import { createServerFn } from '@tanstack/react-start'
import { count, desc, eq, isNull } from 'drizzle-orm'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

import { db } from '#/db'
import { adminUsers, memos, siteSettings, user } from '#/db/schema'
import { auth } from '#/lib/auth'

import { adminMiddleware, authMiddleware } from './middleware'
import { clientIp, rateLimitOrThrow } from './rate-limit'
import { encryptSettingValue } from './secure-settings'
import { toggleGlobalPinForAdmin } from './memos-core'
import { getSessionUserFromRequest } from './session-core'
import {
  hasAnyAdmin,
  isAdminUser,
  loadEmailSettings,
  loadSiteSettings,
  loadS3Settings,
} from './settings-core'

// ── 管理员访问状态 ──────────────────────────────────────
export interface AdminGate {
  hasAdmin: boolean
  isAdmin: boolean
  canClaim: boolean
  adminTokenConfigured: boolean
  currentUserId: string | null
}

export const getAdminGate = createServerFn({ method: 'GET' })
  .validator(z.undefined())
  .handler(async (): Promise<AdminGate> => {
    const sessionUser = await getSessionUserFromRequest()
    const currentUserId = sessionUser?.id ?? null
    const adminExists = await hasAnyAdmin()
    const isAdmin = currentUserId ? await isAdminUser(currentUserId) : false
    return {
      hasAdmin: adminExists,
      isAdmin,
      canClaim: Boolean(
        currentUserId && !adminExists && process.env.ADMIN_TOKEN,
      ),
      adminTokenConfigured: Boolean(process.env.ADMIN_TOKEN),
      currentUserId,
    }
  })

export const claimAdmin = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ token: z.string().min(1).max(1024) }))
  .handler(async ({ data, context }): Promise<{ success: boolean }> => {
    // 防 ADMIN_TOKEN 爆破：全局按 IP 封顶，防止注册多账号换桶绕过
    rateLimitOrThrow(`claim-admin:global:${clientIp()}`, {
      window: 60,
      max: 10,
      message: '尝试过于频繁，请稍后再试',
    })
    rateLimitOrThrow(`claim-admin:${context.user.id}:${clientIp()}`, {
      window: 60,
      max: 5,
      message: '尝试过于频繁，请稍后再试',
    })
    if (await hasAnyAdmin()) {
      throw new Error('站点已有管理员')
    }
    const expected = process.env.ADMIN_TOKEN
    if (!expected) {
      throw new Error('未配置 ADMIN_TOKEN 环境变量')
    }
    if (!safeEqual(data.token, expected)) {
      throw new Error('AdminToken 不正确')
    }
    // 领取后再检查一次，避免并发创建
    if (await hasAnyAdmin()) {
      throw new Error('站点已有管理员')
    }
    await db
      .insert(adminUsers)
      .values({ userId: context.user.id, createdAt: new Date() })
      .onConflictDoNothing()
    return { success: true }
  })

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

// ── 全局置顶 ────────────────────────────────────────────
export const toggleGlobalPin = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ memoId: z.string().min(1) }))
  .handler(async ({ data }) => toggleGlobalPinForAdmin(data.memoId))

// ── 管理端设置视图 ──────────────────────────────────────
export interface AdminSettings {
  siteName: string
  siteDescription: string
  siteIcon: string
  allowSignup: boolean
  defaultVisibility: 'public' | 'private'
  s3: {
    enabled: boolean
    endpoint: string
    region: string
    bucket: string
    accessKeyIdConfigured: boolean
    publicUrl: string
    forcePathStyle: boolean
  }
  smtp: {
    configured: boolean
    host: string
    port: number
    secure: boolean
    user: string
    from: string
    passwordConfigured: boolean
  }
  resend: {
    configured: boolean
    apiKeyConfigured: boolean
    from: string
  }
}

export interface AdminUserItem {
  id: string
  name: string
  email: string
  username: string
  image: string | null
  emailVerified: boolean
  createdAt: string
  memoCount: number
  isAdmin: boolean
}

export interface AdminOverview {
  settings: AdminSettings
  users: AdminUserItem[]
}

export const getAdminOverview = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.undefined())
  .handler(async (): Promise<AdminOverview> => {
    const [site, s3, email, userRows, adminRows, memoRows] = await Promise.all([
      loadSiteSettings(),
      loadS3Settings(),
      loadEmailSettings(),
      db.select().from(user).orderBy(desc(user.createdAt)),
      db.select({ userId: adminUsers.userId }).from(adminUsers),
      db
        .select({ userId: memos.userId, total: count() })
        .from(memos)
        .where(isNull(memos.deletedAt))
        .groupBy(memos.userId),
    ])
    const adminIds = new Set(adminRows.map((row) => row.userId))
    const memoCounts = new Map(memoRows.map((row) => [row.userId, row.total]))

    return {
      settings: {
        siteName: site.name,
        siteDescription: site.description,
        siteIcon: site.icon,
        allowSignup: site.allowSignup,
        defaultVisibility: site.defaultVisibility,
        s3: {
          enabled: s3.enabled,
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          accessKeyIdConfigured: Boolean(s3.accessKeyId),
          publicUrl: s3.publicUrl,
          forcePathStyle: s3.forcePathStyle,
        },
        smtp: {
          configured: email.smtp.configured,
          host: email.smtp.host,
          port: email.smtp.port,
          secure: email.smtp.secure,
          user: email.smtp.user,
          from: email.smtp.from,
          passwordConfigured: Boolean(email.smtp.password),
        },
        resend: {
          configured: email.resend.configured,
          apiKeyConfigured: Boolean(email.resend.apiKey),
          from: email.resend.from,
        },
      },
      users: userRows.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        username: u.username,
        image: u.image,
        emailVerified: u.emailVerified,
        createdAt: u.createdAt.toISOString(),
        memoCount: memoCounts.get(u.id) ?? 0,
        isAdmin: adminIds.has(u.id),
      })),
    }
  })

// ── 保存站点设置 ────────────────────────────────────────
const saveSiteSettingsSchema = z.object({
  siteName: z.string().trim().min(1).max(60),
  siteDescription: z.string().trim().max(500),
  siteIcon: z.string().trim().max(500),
  allowSignup: z.boolean(),
  defaultVisibility: z.enum(['public', 'private']),
  s3: z.object({
    endpoint: z.string().trim().max(300),
    region: z.string().trim().max(100),
    bucket: z.string().trim().max(200),
    accessKeyId: z.string().trim().max(200),
    secretAccessKey: z.string().max(500),
    publicUrl: z.string().trim().max(500),
    forcePathStyle: z.boolean(),
  }),
  smtp: z.object({
    host: z.string().trim().max(300),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().trim().max(300),
    password: z.string().max(500),
    from: z.string().trim().max(300),
  }),
  resend: z.object({
    apiKey: z.string().max(500),
    from: z.string().trim().max(300),
  }),
})

export const saveSiteSettings = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(saveSiteSettingsSchema)
  .handler(async ({ data }): Promise<{ success: boolean }> => {
    const [currentS3, currentEmail] = await Promise.all([
      loadS3Settings(),
      loadEmailSettings(),
    ])
    // 机密项留空表示沿用旧值；落库前加密（AES-256-GCM）
    const s3Secret = data.s3.secretAccessKey || currentS3.secretAccessKey
    const s3AccessKey = data.s3.accessKeyId || currentS3.accessKeyId
    const smtpPassword = data.smtp.password || currentEmail.smtp.password
    const resendApiKey = data.resend.apiKey || currentEmail.resend.apiKey

    const entries: Array<[string, string]> = [
      ['site_name', data.siteName],
      ['site_description', data.siteDescription],
      ['site_icon', data.siteIcon],
      ['allow_signup', String(data.allowSignup)],
      ['default_visibility', data.defaultVisibility],
      ['s3_endpoint', data.s3.endpoint],
      ['s3_region', data.s3.region],
      ['s3_bucket', data.s3.bucket],
      ['s3_access_key_id', s3AccessKey],
      ['s3_secret_access_key', encryptSettingValue(s3Secret)],
      ['s3_public_url', data.s3.publicUrl],
      ['s3_force_path_style', String(data.s3.forcePathStyle)],
      ['smtp_host', data.smtp.host],
      ['smtp_port', String(data.smtp.port)],
      ['smtp_secure', String(data.smtp.secure)],
      ['smtp_user', data.smtp.user],
      ['smtp_pass', encryptSettingValue(smtpPassword)],
      ['smtp_from', data.smtp.from],
      ['resend_api_key', encryptSettingValue(resendApiKey)],
      ['resend_from', data.resend.from],
    ]

    await Promise.all(entries.map(([key, value]) => setSetting(key, value)))
    return { success: true }
  })

async function setSetting(key: string, value: string): Promise<void> {
  if (value === '') {
    await db.delete(siteSettings).where(eq(siteSettings.key, key))
    return
  }
  await db
    .insert(siteSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: siteSettings.key,
      set: { value, updatedAt: new Date() },
    })
}

// ── 用户管理 ────────────────────────────────────────────
export const setUserAdmin = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(
    z.object({
      userId: z.string().min(1),
      admin: z.boolean(),
    }),
  )
  .handler(async ({ data }): Promise<{ success: boolean }> => {
    const target = await db.query.user.findFirst({
      where: eq(user.id, data.userId),
      columns: { id: true },
    })
    if (!target) throw new Error('用户不存在')

    if (data.admin) {
      await db
        .insert(adminUsers)
        .values({ userId: data.userId, createdAt: new Date() })
        .onConflictDoNothing()
    } else {
      const existing = await db.query.adminUsers.findFirst({
        where: eq(adminUsers.userId, data.userId),
        columns: { userId: true },
      })
      if (existing) {
        const rows = await db.select({ total: count() }).from(adminUsers)
        if ((rows[0]?.total ?? 0) <= 1) {
          throw new Error('至少保留一名管理员')
        }
        await db.delete(adminUsers).where(eq(adminUsers.userId, data.userId))
      }
    }
    return { success: true }
  })

export const deleteUser = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ userId: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<{ success: boolean }> => {
    if (data.userId === context.user.id) {
      throw new Error('不能删除当前登录的管理员')
    }
    const target = await db.query.user.findFirst({
      where: eq(user.id, data.userId),
      columns: { id: true },
    })
    if (!target) throw new Error('用户不存在')

    const authCtx = await auth.$context
    await authCtx.internalAdapter.deleteUser(data.userId)
    await authCtx.internalAdapter.deleteUserSessions(data.userId)
    return { success: true }
  })
