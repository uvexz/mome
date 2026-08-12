import { describe, expect, test } from 'bun:test'

import { buildCaptureBookmarklet } from './bookmarklet'

describe('capture bookmarklet', () => {
  test('targets the current mome origin without embedding credentials', () => {
    const bookmarklet = buildCaptureBookmarklet(
      'https://mome.example.com/settings?tab=api',
    )

    expect(bookmarklet.startsWith('javascript:')).toBe(true)
    expect(bookmarklet).toContain('https://mome.example.com')
    expect(bookmarklet).toContain('/capture')
    expect(bookmarklet).toContain('u.searchParams.set("tag","收藏")')
    expect(bookmarklet).not.toContain('mome_')
    expect(bookmarklet).not.toContain('/settings')
  })

  test('rejects origins that cannot host the capture route', () => {
    expect(() => buildCaptureBookmarklet('file:///tmp/mome')).toThrow()
  })
})
