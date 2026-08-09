import { describe, expect, it } from 'vitest'

import { escapeLike } from '../src/lib/search'

describe('escapeLike', () => {
  it('转义 % _ 与反斜杠', () => {
    expect(escapeLike('100%_done\\x')).toBe('100\\%\\_done\\\\x')
  })

  it('普通文本保持不变', () => {
    expect(escapeLike('hello 世界 #tag')).toBe('hello 世界 #tag')
  })
})
