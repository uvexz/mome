/**
 * ULID 生成（纯函数，无依赖）。
 * 26 位 Crockford Base32：前 10 位为 48-bit 毫秒时间戳，后 16 位为随机数。
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function ulid(): string {
  const now = BigInt(Date.now())
  const randomBytes = crypto.getRandomValues(new Uint8Array(10))
  let random = 0n
  for (const byte of randomBytes) {
    random = (random << 8n) | BigInt(byte)
  }
  const value = (now << 80n) | random

  let out = ''
  let v = value
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(v & 31n)] + out
    v >>= 5n
  }
  return out
}
