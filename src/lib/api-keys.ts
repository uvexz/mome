import { createHash, randomBytes } from 'node:crypto'

export const API_KEY_PREFIX = 'mome_'

/** 生成只展示一次的 API key（mome_ + 32 字节随机值） */
export function generateApiKeyToken(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** 对 token 做 SHA-256，数据库中只保存哈希 */
export function hashApiKeyToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 界面展示用前缀，如 mome_ab12cd34… */
export function apiKeyPrefix(token: string): string {
  return token.slice(0, 12)
}
