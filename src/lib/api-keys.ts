import { createHash, randomBytes } from 'node:crypto'

export const API_KEY_PREFIX = 'mome_'

/** Memos 兼容层的 Personal Access Token 前缀（与 usememos/memos 一致） */
export const MEMOS_PAT_PREFIX = 'memos_pat_'

/** 生成只展示一次的 API key（mome_ + 32 字节随机值） */
export function generateApiKeyToken(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** 生成只展示一次的 Memos 兼容 PAT（memos_pat_ + 32 字节随机值） */
export function generateMemosPatToken(): string {
  return `${MEMOS_PAT_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** 对 token 做 SHA-256，数据库中只保存哈希 */
export function hashApiKeyToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 界面展示用前缀，如 mome_ab12cd34… */
export function apiKeyPrefix(token: string): string {
  return token.slice(0, 12)
}
