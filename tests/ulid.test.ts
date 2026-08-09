import { describe, expect, it } from 'vitest'

import { ulid } from '#/lib/ulid'

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/

describe('ulid', () => {
  it('生成 26 位 Crockford Base32', () => {
    expect(ulid()).toMatch(CROCKFORD)
  })

  it('连续生成不重复', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()))
    expect(ids.size).toBe(1000)
  })

  it('时间戳前缀随时间递增', async () => {
    const a = ulid()
    await new Promise((r) => setTimeout(r, 2))
    const b = ulid()
    expect(a < b).toBe(true)
  })
})
