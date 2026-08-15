import { eq } from 'drizzle-orm'

import { db } from '#/db'
import { adminUsers, siteSettings } from '#/db/schema'

import { decryptSettingValue } from './secure-settings'

export type DefaultMemoVisibility = 'public' | 'private'

export interface SiteSettings {
  name: string
  description: string
  icon: string
  allowSignup: boolean
  defaultVisibility: DefaultMemoVisibility
}

export interface S3RuntimeSettings {
  enabled: boolean
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  publicUrl: string
  forcePathStyle: boolean
}

export interface EmailRuntimeSettings {
  enabled: boolean
  provider: 'smtp' | 'resend' | 'console' | 'none'
  smtp: {
    host: string
    port: number
    secure: boolean
    user: string
    password: string
    from: string
    configured: boolean
  }
  resend: {
    apiKey: string
    from: string
    configured: boolean
  }
}

let settingsCache:
  { expiresAt: number; value: Promise<Map<string, string>> } | undefined

function readSettings(): Promise<Map<string, string>> {
  const now = Date.now()
  if (settingsCache && settingsCache.expiresAt > now) return settingsCache.value
  const value = db
    .select({ key: siteSettings.key, value: siteSettings.value })
    .from(siteSettings)
    .then((rows) => new Map(rows.map((row) => [row.key, row.value])))
  settingsCache = { expiresAt: now + 60_000, value }
  return value
}

export function invalidateSettingsCache(): void {
  settingsCache = undefined
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === 'true' || value === '1'
}

/** 站点公开信息：名称 / 简介 / 图标 / 注册开关 / 默认可见性 */
export async function loadSiteSettings(): Promise<SiteSettings> {
  const map = await readSettings()
  return {
    name: map.get('site_name')?.trim() || process.env.MOME_SITE_NAME || 'mome',
    description:
      map.get('site_description')?.trim() ||
      process.env.MOME_SITE_DESCRIPTION ||
      '极简 memos —— 快速记录碎片想法',
    icon:
      map.get('site_icon')?.trim() ||
      process.env.MOME_SITE_ICON ||
      '/favicon.png',
    allowSignup: parseBool(
      map.get('allow_signup'),
      process.env.MOME_ALLOW_SIGNUP !== 'false',
    ),
    defaultVisibility:
      map.get('default_visibility') === 'public' ? 'public' : 'private',
  }
}

/** S3 运行时配置：管理员页面保存值优先，其次环境变量 */
export async function loadS3Settings(): Promise<S3RuntimeSettings> {
  const map = await readSettings()
  const endpoint =
    map.get('s3_endpoint')?.trim() || process.env.S3_ENDPOINT || ''
  const region =
    map.get('s3_region')?.trim() || process.env.S3_REGION || 'us-east-1'
  const bucket = map.get('s3_bucket')?.trim() || process.env.S3_BUCKET || ''
  const accessKeyId =
    map.get('s3_access_key_id')?.trim() || process.env.S3_ACCESS_KEY_ID || ''
  const secretAccessKey =
    decryptSettingValue(map.get('s3_secret_access_key') ?? '') ||
    process.env.S3_SECRET_ACCESS_KEY ||
    ''
  const publicUrl =
    map.get('s3_public_url')?.trim() || process.env.S3_PUBLIC_URL || ''
  const forcePathStyle = parseBool(
    map.get('s3_force_path_style'),
    process.env.S3_FORCE_PATH_STYLE !== 'false',
  )
  return {
    enabled: Boolean(endpoint && bucket && accessKeyId && secretAccessKey),
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicUrl,
    forcePathStyle,
  }
}

/** 邮件运行时配置：SMTP → Resend → 开发控制台 → 未配置 */
export async function loadEmailSettings(): Promise<EmailRuntimeSettings> {
  const map = await readSettings()
  const smtp = {
    host: map.get('smtp_host')?.trim() || process.env.SMTP_HOST || '',
    port: Number(map.get('smtp_port')?.trim() || process.env.SMTP_PORT || 587),
    secure: parseBool(
      map.get('smtp_secure'),
      process.env.SMTP_SECURE === 'true',
    ),
    user: map.get('smtp_user')?.trim() || process.env.SMTP_USER || '',
    password:
      decryptSettingValue(map.get('smtp_pass') ?? '') ||
      process.env.SMTP_PASS ||
      '',
    from:
      map.get('smtp_from')?.trim() ||
      process.env.SMTP_FROM ||
      process.env.RESEND_FROM ||
      'mome@localhost',
    configured: false,
  }
  smtp.configured = Boolean(smtp.host)

  const resend = {
    apiKey:
      decryptSettingValue(map.get('resend_api_key') ?? '') ||
      process.env.RESEND_API_KEY ||
      '',
    from: map.get('resend_from')?.trim() || process.env.RESEND_FROM || '',
    configured: false,
  }
  resend.configured = Boolean(resend.apiKey && resend.from)

  const provider = smtp.configured
    ? ('smtp' as const)
    : resend.configured
      ? ('resend' as const)
      : process.env.MOME_EMAIL_DEV === 'console'
        ? ('console' as const)
        : ('none' as const)

  return {
    enabled: provider !== 'none',
    provider,
    smtp,
    resend,
  }
}

export async function isAdminUser(userId: string): Promise<boolean> {
  const row = await db.query.adminUsers.findFirst({
    where: eq(adminUsers.userId, userId),
    columns: { userId: true },
  })
  return Boolean(row)
}

export async function hasAnyAdmin(): Promise<boolean> {
  const rows = await db
    .select({ userId: adminUsers.userId })
    .from(adminUsers)
    .limit(1)
  return rows.length > 0
}
