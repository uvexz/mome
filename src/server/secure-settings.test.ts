import { afterEach, describe, expect, test } from 'bun:test'

import { decryptSettingValue, encryptSettingValue } from './secure-settings'

const originalNodeEnv = process.env.NODE_ENV
const originalSecret = process.env.BETTER_AUTH_SECRET

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET
  else process.env.BETTER_AUTH_SECRET = originalSecret
})

describe('secure settings', () => {
  test('encrypts and decrypts values with a valid secret', () => {
    process.env.NODE_ENV = 'test'
    process.env.BETTER_AUTH_SECRET = 'test-secret-with-at-least-32-characters'
    const encrypted = encryptSettingValue('smtp-password')

    expect(encrypted).not.toBe('smtp-password')
    expect(decryptSettingValue(encrypted)).toBe('smtp-password')
  })

  test('rejects production encryption without a sufficiently strong secret', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.BETTER_AUTH_SECRET

    expect(() => encryptSettingValue('smtp-password')).toThrow(
      'BETTER_AUTH_SECRET 至少需要 32 个字符',
    )

    process.env.BETTER_AUTH_SECRET = 'short'
    expect(() => encryptSettingValue('smtp-password')).toThrow(
      'BETTER_AUTH_SECRET 至少需要 32 个字符',
    )
  })
})
