import { describe, expect, it } from 'vitest'

import { isValidUsername, usernameSuggestion } from '#/lib/username'

describe('isValidUsername', () => {
  it.each([
    ['jake', true],
    ['jake_li', true],
    ['jake-li', true],
    ['a1b2c3', true],
    ['ab', false],
    ['_jake', false],
    ['-jake', false],
    ['Jake', false],
    ['jake!', false],
    ['jake li', false],
    ['a'.repeat(31), false],
    ['a'.repeat(30), true],
  ])('%s → %s', (value, expected) => {
    expect(isValidUsername(value)).toBe(expected)
  })
})

describe('usernameSuggestion', () => {
  it('由邮箱前缀生成', () => {
    expect(usernameSuggestion('Jake.Li@example.com')).toBe('jakeli')
  })

  it('过短时补充随机后缀', () => {
    expect(usernameSuggestion('a@b.com')).toMatch(/^a\d{4}$/)
  })

  it('无前缀时兜底', () => {
    expect(usernameSuggestion('@b.com')).toMatch(/^user\d{6}$/)
  })
})
