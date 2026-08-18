import { describe, expect, test } from 'bun:test'

import { resolveAvatarUrl } from './avatar'

describe('resolveAvatarUrl', () => {
  test('keeps a custom avatar URL', () => {
    const image = 'https://example.com/avatar.png'

    expect(resolveAvatarUrl(image, 'alice')).toBe(image)
  })

  test('generates a stable blobatar from the username', () => {
    const avatar = resolveAvatarUrl(null, 'alice')

    expect(avatar).toStartWith('data:image/svg+xml,')
    expect(resolveAvatarUrl(undefined, 'alice')).toBe(avatar)
    expect(resolveAvatarUrl(null, 'bob')).not.toBe(avatar)
  })
})
