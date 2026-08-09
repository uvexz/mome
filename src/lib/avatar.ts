/**
 * 头像工具：Gravatar 风格，base url 为 https://cdn.sevencdn.com/avatar/HASH
 * HASH = md5(email 去空白小写)
 */

// 紧凑的 md5 实现（纯函数，无依赖）
function md5(input: string): string {
  function rotl(x: number, c: number): number {
    return (x << c) | (x >>> (32 - c))
  }
  function addUnsigned(lX: number, lY: number): number {
    const lX8 = lX & 0x80000000
    const lY8 = lY & 0x80000000
    const lX4 = lX & 0x40000000
    const lY4 = lY & 0x40000000
    const lResult = (lX & 0x3fffffff) + (lY & 0x3fffffff)
    if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8
    if (lX4 | lY4) {
      if (lResult & 0x40000000) return lResult ^ 0xc0000000 ^ lX8 ^ lY8
      return lResult ^ 0x40000000 ^ lX8 ^ lY8
    }
    return lResult ^ lX8 ^ lY8
  }
  const k = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
    0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
    0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
    0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
    0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
    0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ]
  const r = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
    9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
    16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
    15, 21,
  ]

  const bytes = Array.from(new TextEncoder().encode(input))

  const originalLength = bytes.length
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  // 消息长度（bit）以 64 位小端写入；JS 移位按 mod 32 处理，故高位 4 字节单独补 0
  const bitLen = originalLength * 8
  for (let i = 0; i < 4; i++) bytes.push((bitLen >>> (i * 8)) & 0xff)
  for (let i = 0; i < 4; i++) bytes.push(0)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    const m: number[] = []
    for (let j = 0; j < 16; j++) {
      m[j] =
        bytes[chunk + j * 4] |
        (bytes[chunk + j * 4 + 1] << 8) |
        (bytes[chunk + j * 4 + 2] << 16) |
        (bytes[chunk + j * 4 + 3] << 24)
    }
    let A = a0
    let B = b0
    let C = c0
    let D = d0
    for (let i = 0; i < 64; i++) {
      let F: number
      let g: number
      if (i < 16) {
        F = (B & C) | (~B & D)
        g = i
      } else if (i < 32) {
        F = (D & B) | (~D & C)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        F = B ^ C ^ D
        g = (3 * i + 5) % 16
      } else {
        F = C ^ (B | ~D)
        g = (7 * i) % 16
      }
      F = addUnsigned(F, addUnsigned(addUnsigned(A, k[i]), m[g])) >>> 0
      const temp = D
      D = C
      C = B
      B = addUnsigned(B, rotl(F, r[i]))
      A = temp
    }
    a0 = addUnsigned(a0, A)
    b0 = addUnsigned(b0, B)
    c0 = addUnsigned(c0, C)
    d0 = addUnsigned(d0, D)
  }

  // md5 输出：每个 32 位字按小端字节序写成 hex
  function toHex(n: number): string {
    return [n, n >>> 8, n >>> 16, n >>> 24]
      .map((b) => (b & 0xff).toString(16).padStart(2, '0'))
      .join('')
  }
  return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0)
}

export const GRAVATAR_BASE_URL = 'https://cdn.sevencdn.com/avatar'

/** 由邮箱生成头像 URL：https://cdn.sevencdn.com/avatar/<md5(email)> */
export function getAvatarUrl(email: string): string {
  const hash = md5(email.trim().toLowerCase())
  return `${GRAVATAR_BASE_URL}/${hash}`
}

/** 头像展示 URL：优先用户自定义 image，其次 gravatar，最后回退默认头像 */
export function resolveAvatarUrl(
  image: string | null | undefined,
  email: string | null | undefined,
): string {
  if (image) return image
  if (email) return getAvatarUrl(email)
  return DEFAULT_AVATAR
}

/** 默认头像（无邮箱时使用） */
export const DEFAULT_AVATAR = '/mome.png'
