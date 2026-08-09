import { describe, expect, it } from 'vitest'

import {
  API_KEY_PREFIX,
  apiKeyPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
} from '#/lib/api-keys'

describe('api keys', () => {
  it('生成带前缀的随机 token', () => {
    const token = generateApiKeyToken()
    expect(token.startsWith(API_KEY_PREFIX)).toBe(true)
    expect(token.length).toBe(API_KEY_PREFIX.length + 43)
    expect(generateApiKeyToken()).not.toBe(token)
  })

  it('哈希不可逆且稳定', () => {
    const token = generateApiKeyToken()
    expect(hashApiKeyToken(token)).toMatch(/^[a-f0-9]{64}$/)
    expect(hashApiKeyToken(token)).toBe(hashApiKeyToken(token))
    expect(hashApiKeyToken(token)).not.toBe(hashApiKeyToken(`${token}x`))
  })

  it('展示前缀只包含开头部分', () => {
    const token = generateApiKeyToken()
    expect(apiKeyPrefix(token)).toBe(token.slice(0, 12))
    expect(apiKeyPrefix(token)).not.toContain(token.slice(12))
  })
})
