/**
 * 站点运行时机密（S3 secret / SMTP 密码 / Resend key）的落库加密。
 * AES-256-GCM，密钥由 BETTER_AUTH_SECRET 经 SHA-256 派生。
 * 存储格式：v1:<iv_b64url>:<tag_b64url>:<ciphertext_b64url>
 * 读取兼容历史明文值；未配置 BETTER_AUTH_SECRET 时退化为明文（开发环境）。
 * 注意：更换 BETTER_AUTH_SECRET 前需先在管理页清空机密项或重新录入。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'

const PREFIX = 'v1:'

function deriveKey(): Buffer | null {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) return null
  return createHash('sha256').update(secret).digest()
}

export function encryptSettingValue(value: string): string {
  if (!value) return value
  const key = deriveKey()
  if (!key) return value
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`
}

export function decryptSettingValue(value: string): string {
  if (!value.startsWith(PREFIX)) return value
  const key = deriveKey()
  if (!key) {
    console.error('[settings] 缺少 BETTER_AUTH_SECRET，无法解密站点机密配置')
    return ''
  }
  try {
    const [iv, tag, ciphertext] = value
      .slice(PREFIX.length)
      .split(':')
      .map((part) => Buffer.from(part, 'base64url'))
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    console.error(
      '[settings] 站点机密配置解密失败（BETTER_AUTH_SECRET 是否变更过？）',
    )
    return ''
  }
}
