import { describe, expect, it } from 'vitest'

import {
  DEFAULT_AVATAR,
  GRAVATAR_BASE_URL,
  getAvatarUrl,
  resolveAvatarUrl,
} from '../src/lib/avatar'

describe('getAvatarUrl', () => {
  it('生成 cdn.sevencdn.com 头像 URL', () => {
    expect(getAvatarUrl('test@example.com')).toBe(
      'https://cdn.sevencdn.com/avatar/55502f40dc8b7c769880b10874abc9d0',
    )
  })

  it('邮箱去空白并小写后再做 md5', () => {
    expect(getAvatarUrl('  User@Example.COM ')).toBe(
      getAvatarUrl('user@example.com'),
    )
    expect(getAvatarUrl('  User@Example.COM ')).toBe(
      `https://cdn.sevencdn.com/avatar/b58996c504c5638798eb6b511e6f49af`,
    )
  })

  it('与标准 md5 一致（含 UTF-8）', async () => {
    // 标准 md5 参考值（Node crypto 校验）
    const cases: Array<[string, string]> = [
      ['abc', '900150983cd24fb0d6963f7d28e17f72'],
      ['', 'd41d8cd98f00b204e9800998ecf8427e'],
      ['a@b.cn', '4850b0f4a190c3bb082ae6c25fbc2284'],
      ['测试@example.com', 'aaa974d4d95506f7f0ab2d6f8f5066e3'],
    ]
    for (const [email, hash] of cases) {
      expect(getAvatarUrl(email)).toBe(`${GRAVATAR_BASE_URL}/${hash}`)
    }
  })

  it('默认头像为 /mome.png', () => {
    expect(DEFAULT_AVATAR).toBe('/mome.png')
  })

  it('优先自定义头像，其次 gravatar，最后回退默认头像', () => {
    const custom = 'https://example.com/avatar.png'
    const email = 'test@example.com'
    expect(resolveAvatarUrl(custom, email)).toBe(custom)
    expect(resolveAvatarUrl(null, email)).toBe(getAvatarUrl(email))
    expect(resolveAvatarUrl(undefined, null)).toBe(DEFAULT_AVATAR)
  })
})
