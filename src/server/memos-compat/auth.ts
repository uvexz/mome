/**
 * Memos 兼容层鉴权。
 *
 * 支持三种凭据，与 usememos/memos 客户端的行为对齐：
 * 1. `Authorization: Bearer <access token>`：signin 签发的 HS256 JWT（15 分钟）；
 * 2. `Authorization: Bearer memos_pat_...` / `mome_...`：PAT / API key（查库哈希校验）；
 * 3. Better Auth cookie session：浏览器内直接携带站点会话即可调用。
 *
 * 签名密钥由 BETTER_AUTH_SECRET 派生（HKDF 风格派生，避免与 Better Auth
 * 自身的签名用途混用）。token 与上游不是字节级 parity，仅保证客户端可用。
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { and, eq, gt, isNull, lt } from 'drizzle-orm'

import { db } from '#/db'
import { compatRefreshTokens, user } from '#/db/schema'
import { auth } from '#/lib/auth'
import { authenticateApiKeyToken } from '../api-keys-core'
import { isAdminUser } from '../settings-core'
import { Code, MemosError } from './errors'

const ISSUER = 'mome'
const ACCESS_AUDIENCE = 'user.access-token'
const REFRESH_AUDIENCE = 'user.refresh-token'

/** access token 15 分钟、refresh token 30 天，与上游常量一致 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
export const REFRESH_COOKIE_NAME = 'memos_refresh'

export interface CompatActor {
  id: string
  username: string
  name: string
  email: string
  image: string | null
  bio: string | null
  createdAt: string
  isAdmin: boolean
}

interface TokenClaims {
  iss: string
  aud: string
  sub: string
  exp: number
  iat: number
  name?: string
  jti?: string
}

function signingKey(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) {
    throw new MemosError(
      Code.INTERNAL,
      'BETTER_AUTH_SECRET 未配置，无法签发 Memos 兼容 token',
    )
  }
  return createHmac('sha256', secret).update('mome/memos-compat/v1').digest()
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function signJwt(claims: TokenClaims): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'v1' }))
  const payload = b64url(JSON.stringify(claims))
  const signature = createHmac('sha256', signingKey())
    .update(`${header}.${payload}`)
    .digest('base64url')
  return `${header}.${payload}.${signature}`
}

function verifyJwt(token: string, audience: string): TokenClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const expected = createHmac('sha256', signingKey())
    .update(`${parts[0]}.${parts[1]}`)
    .digest()
  const provided = Buffer.from(parts[2], 'base64url')
  if (provided.length !== expected.length) return null
  if (!timingSafeEqual(expected, provided)) return null
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString(),
    )
    if (!claims || typeof claims !== 'object') return null
    const { iss, aud, sub, exp, iat } = claims as Partial<TokenClaims>
    if (iss !== ISSUER || aud !== audience) return null
    if (typeof sub !== 'string' || sub.length === 0) return null
    if (typeof exp !== 'number' || exp * 1000 <= Date.now()) return null
    return { ...(claims as TokenClaims), iss, aud, sub, exp, iat: iat ?? 0 }
  } catch {
    return null
  }
}

export interface IssuedAccessToken {
  accessToken: string
  expiresAt: Date
}

export function issueAccessToken(
  userId: string,
  username: string,
): IssuedAccessToken {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + ACCESS_TOKEN_TTL_SECONDS
  return {
    accessToken: signJwt({
      iss: ISSUER,
      aud: ACCESS_AUDIENCE,
      sub: userId,
      name: username,
      jti: randomUUID(),
      iat: now,
      exp,
    }),
    expiresAt: new Date(exp * 1000),
  }
}

export async function issueRefreshToken(userId: string): Promise<{
  refreshToken: string
  expiresAt: Date
}> {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + REFRESH_TOKEN_TTL_SECONDS
  const jti = randomUUID()
  const expiresAt = new Date(exp * 1000)
  await db.insert(compatRefreshTokens).values({
    id: jti,
    userId,
    createdAt: new Date(now * 1000),
    expiresAt,
  })
  // 顺带清理已过期记录，避免表随签发量无限增长
  await db
    .delete(compatRefreshTokens)
    .where(lt(compatRefreshTokens.expiresAt, new Date()))
  return {
    refreshToken: signJwt({
      iss: ISSUER,
      aud: REFRESH_AUDIENCE,
      sub: userId,
      jti,
      iat: now,
      exp,
    }),
    expiresAt,
  }
}

/**
 * 单次消费 refresh token：签名/有效期之外还要求服务端记录存在且未撤销，
 * 并在同一条件更新里标记已消费，重放与并发刷新只有一个能成功。
 */
export async function consumeRefreshToken(
  token: string,
): Promise<string | null> {
  const claims = verifyJwt(token, REFRESH_AUDIENCE)
  if (!claims?.jti) return null
  const consumed = await db
    .update(compatRefreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(compatRefreshTokens.id, claims.jti),
        eq(compatRefreshTokens.userId, claims.sub),
        isNull(compatRefreshTokens.revokedAt),
        gt(compatRefreshTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: compatRefreshTokens.userId })
  return consumed.at(0)?.userId ?? null
}

/** 退出/改密/撤销会话时调用：让该用户全部兼容 refresh 凭据立即失效 */
export async function revokeRefreshTokensForUser(
  userId: string,
): Promise<void> {
  await db
    .update(compatRefreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(compatRefreshTokens.userId, userId),
        isNull(compatRefreshTokens.revokedAt),
      ),
    )
}

/** 只解析 refresh token 的用户，不消费（signout 用） */
export function refreshTokenSubject(token: string): string | null {
  return verifyJwt(token, REFRESH_AUDIENCE)?.sub ?? null
}

function verifyAccessToken(token: string): string | null {
  return verifyJwt(token, ACCESS_AUDIENCE)?.sub ?? null
}

export function refreshCookie(token: string, expiresAt: Date): string {
  const secure = (process.env.BETTER_AUTH_URL ?? '').startsWith('https://')
  const attrs = [
    `${REFRESH_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ]
  if (secure) attrs.push('Secure')
  return attrs.join('; ')
}

export function clearRefreshCookie(): string {
  return `${REFRESH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

export function readRefreshCookie(request: Request): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === REFRESH_COOKIE_NAME) return rest.join('=') || null
  }
  return null
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : null
}

async function loadActor(userId: string): Promise<CompatActor | null> {
  const row = await db.query.user.findFirst({ where: eq(user.id, userId) })
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    email: row.email,
    image: row.image,
    bio: row.bio ?? null,
    createdAt: row.createdAt.toISOString(),
    isAdmin: await isAdminUser(row.id),
  }
}

/** 解析请求凭据；未携带或无效凭据返回 null（匿名可读接口用） */
export async function authenticate(
  request: Request,
): Promise<CompatActor | null> {
  const token = bearerToken(request)
  if (token) {
    if (!token.includes('.')) {
      const apiUser = await authenticateApiKeyToken(token)
      if (!apiUser) return null
      return loadActor(apiUser.id)
    }
    const userId = verifyAccessToken(token)
    if (!userId) return null
    return loadActor(userId)
  }

  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session) return null
    return loadActor(session.user.id)
  } catch (error) {
    console.error('[memos-compat] session 解析失败', error)
    return null
  }
}

export async function requireActor(request: Request): Promise<CompatActor> {
  const actor = await authenticate(request)
  if (!actor) {
    throw new MemosError(
      Code.UNAUTHENTICATED,
      '缺少或无效的凭据：请使用 Authorization: Bearer <access token | PAT>',
    )
  }
  return actor
}
