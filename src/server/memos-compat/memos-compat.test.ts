import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createClient } from '@libsql/client'
import { eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { join } from 'node:path'

import { useTestDatabase } from '../test-db'

process.env.BETTER_AUTH_SECRET ??= 'memos-compat-test-secret'
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000'
useTestDatabase()

const OWNER_ID = 'compat-owner'
const OTHER_ID = 'compat-other'

async function loadModules() {
  return {
    handlers: await import('./handlers'),
    keys: await import('../api-keys-core'),
    memosCore: await import('../memos-core'),
    db: (await import('#/db')).db,
    schema: await import('#/db/schema'),
  }
}

let mods: Awaited<ReturnType<typeof loadModules>>
let ownerToken = ''
let otherToken = ''
let signupUserId = ''

interface ApiResult {
  status: number
  body: Record<string, unknown>
  headers: Headers
}

async function call(
  method: string,
  path: string,
  opts: {
    token?: string
    body?: unknown
    headers?: Record<string, string>
  } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const response = await mods.handlers.handleMemosCompat(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  )
  const text = await response.text()
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    headers: response.headers,
  }
}

function memoBody(content: string, extra: Record<string, unknown> = {}) {
  return { content, ...extra }
}

/**
 * 还原被临时覆盖的 S3 环境变量。
 * 直接赋 undefined 会被写成字符串 "undefined"，反而让 S3 看起来是配置好的。
 */
function restoreEnv(snapshot: NodeJS.ProcessEnv, keys: string[]): void {
  for (const key of keys) {
    const previous = snapshot[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
}

/** 起一个本地 stub S3 并把连接参数指向它；调用方负责在 finally 里 stop + restoreEnv */
function stubS3(
  onRequest: (request: Request) => Response | Promise<Response>,
): { server: ReturnType<typeof Bun.serve>; env: NodeJS.ProcessEnv } {
  const server = Bun.serve({ port: 0, fetch: onRequest })
  const env = { ...process.env }
  process.env.S3_ENDPOINT = `http://127.0.0.1:${server.port}`
  process.env.S3_BUCKET = 'mome-test'
  process.env.S3_ACCESS_KEY_ID = 'test-key'
  process.env.S3_SECRET_ACCESS_KEY = 'test-secret'
  process.env.S3_FORCE_PATH_STYLE = 'true'
  return { server, env }
}

const S3_ENV_KEYS = [
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_PUBLIC_URL',
  'S3_FORCE_PATH_STYLE',
]

beforeAll(async () => {
  const client = createClient({ url: process.env.DATABASE_URL! })
  await migrate(drizzle(client), {
    migrationsFolder: join(import.meta.dir, '../../../drizzle'),
  })
  await client.close()

  mods = await loadModules()
  const now = new Date()
  await mods.db.insert(mods.schema.user).values([
    {
      id: OWNER_ID,
      name: 'Owner',
      email: 'compat-owner@example.com',
      username: 'compatowner',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: OTHER_ID,
      name: 'Other',
      email: 'compat-other@example.com',
      username: 'compatother',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  ])
  await mods.db
    .insert(mods.schema.adminUsers)
    .values({ userId: OWNER_ID, createdAt: now })

  ownerToken = (
    await mods.keys.createApiKeyForUser(OWNER_ID, 'owner pat', {
      kind: 'memosPat',
    })
  ).token
  otherToken = (
    await mods.keys.createApiKeyForUser(OTHER_ID, 'other pat', {
      kind: 'memosPat',
    })
  ).token
})

afterAll(async () => {
  // 同一进程内的测试文件共享 #/db 单例：只清理本文件写入的用户（外键级联
  // 带走 memo/tag/api key/admin 等），避免污染 memos-core.test.ts 的断言
  await mods.db
    .delete(mods.schema.user)
    .where(inArray(mods.schema.user.id, [OWNER_ID, OTHER_ID, signupUserId]))
})

describe('memos compat auth', () => {
  test('rejects anonymous access with gRPC UNAUTHENTICATED', async () => {
    const res = await call('GET', '/api/v1/auth/me')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(16)
  })

  test('accepts memos_pat_ tokens and maps user resource names', async () => {
    expect(ownerToken.startsWith('memos_pat_')).toBe(true)
    const res = await call('GET', '/api/v1/auth/me', { token: ownerToken })
    expect(res.status).toBe(200)
    const user = res.body.user as Record<string, unknown>
    expect(user.name).toBe(`users/${OWNER_ID}`)
    expect(user.role).toBe('ADMIN')
    expect(user.username).toBe('compatowner')
    expect(user.email).toBe('compat-owner@example.com')
  })

  test('signin issues an access token that the API accepts, refresh rotates it', async () => {
    const signup = await (
      await import('#/lib/auth')
    ).auth.api.signUpEmail({
      body: {
        email: 'signin@example.com',
        password: 'password1234',
        name: 'Signin User',
        username: 'signinuser',
      },
    })
    expect(signup.user.id).toBeTruthy()
    signupUserId = signup.user.id

    const signin = await call('POST', '/api/v1/auth/signin', {
      body: {
        passwordCredentials: {
          username: 'signinuser',
          password: 'password1234',
        },
      },
    })
    expect(signin.status).toBe(200)
    const accessToken = signin.body.accessToken as string
    expect(typeof accessToken).toBe('string')
    const cookie = signin.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('memos_refresh=')

    const me = await call('GET', '/api/v1/auth/me', { token: accessToken })
    expect(me.status).toBe(200)
    expect((me.body.user as Record<string, unknown>).username).toBe(
      'signinuser',
    )

    const refreshHeaders = {
      cookie: cookie.split(';')[0],
      origin: 'http://localhost:3000',
    }
    const refresh = await call('POST', '/api/v1/auth/refresh', {
      headers: refreshHeaders,
    })
    expect(refresh.status).toBe(200)
    const refreshed = refresh.body.accessToken as string
    expect(refreshed).not.toBe(accessToken)
    expect(
      (await call('GET', '/api/v1/auth/me', { token: refreshed })).status,
    ).toBe(200)

    // 旧 refresh token 只能消费一次：轮换后重放必须失败
    const replay = await call('POST', '/api/v1/auth/refresh', {
      headers: refreshHeaders,
    })
    expect(replay.status).toBe(401)

    // signout 撤销该用户全部兼容 refresh 记录，新 token 同样失效
    const rotated = (refresh.headers.get('set-cookie') ?? '').split(';')[0]
    const signout = await call('POST', '/api/v1/auth/signout', {
      headers: { cookie: rotated, origin: 'http://localhost:3000' },
    })
    expect(signout.status).toBe(200)
    expect(signout.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(
      (
        await call('POST', '/api/v1/auth/refresh', {
          headers: { cookie: rotated, origin: 'http://localhost:3000' },
        })
      ).status,
    ).toBe(401)
  })

  test('signin with a wrong password returns UNAUTHENTICATED', async () => {
    const res = await call('POST', '/api/v1/auth/signin', {
      body: {
        passwordCredentials: { username: 'signinuser', password: 'wrong' },
      },
    })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(16)
  })
})

describe('memos compat memo CRUD', () => {
  test('creates, reads, updates and deletes a memo', async () => {
    const created = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('hello #工作/项目 world', { pinned: true }),
    })
    expect(created.status).toBe(200)
    const memo = created.body
    const name = memo.name as string
    expect(name.startsWith('memos/')).toBe(true)
    expect(memo.visibility).toBe('PRIVATE')
    expect(memo.state).toBe('NORMAL')
    expect(memo.creator).toBe(`users/${OWNER_ID}`)
    expect(memo.tags).toEqual(['工作/项目'])
    expect(memo.pinned).toBe(true)
    expect((memo.property as Record<string, unknown>).hasLink).toBe(false)

    const memoId = name.slice('memos/'.length)
    const fetched = await call('GET', `/api/v1/memos/${memoId}`, {
      token: ownerToken,
    })
    expect(fetched.status).toBe(200)
    expect(fetched.body.content).toBe('hello #工作/项目 world')

    const updated = await call(
      'PATCH',
      `/api/v1/memos/${memoId}?updateMask=content,visibility,pinned`,
      {
        token: ownerToken,
        body: {
          name,
          content: 'edited with a link https://example.com',
          visibility: 'PUBLIC',
          pinned: false,
        },
      },
    )
    expect(updated.status).toBe(200)
    expect(updated.body.content).toBe('edited with a link https://example.com')
    expect(updated.body.visibility).toBe('PUBLIC')
    expect(updated.body.pinned).toBe(false)
    expect((updated.body.property as Record<string, unknown>).hasLink).toBe(
      true,
    )

    const archived = await call(
      'PATCH',
      `/api/v1/memos/${memoId}?updateMask=state`,
      { token: ownerToken, body: { name, state: 'ARCHIVED' } },
    )
    expect(archived.status).toBe(200)
    expect(archived.body.state).toBe('ARCHIVED')

    const normalList = await call('GET', '/api/v1/memos', {
      token: ownerToken,
    })
    expect(
      (normalList.body.memos as Array<Record<string, unknown>>).some(
        (item) => item.name === name,
      ),
    ).toBe(false)
    const archivedList = await call('GET', '/api/v1/memos?state=ARCHIVED', {
      token: ownerToken,
    })
    expect(
      (archivedList.body.memos as Array<Record<string, unknown>>).some(
        (item) => item.name === name,
      ),
    ).toBe(true)

    const deleted = await call('DELETE', `/api/v1/memos/${memoId}`, {
      token: ownerToken,
    })
    expect(deleted.status).toBe(200)
    expect(
      (await call('GET', `/api/v1/memos/${memoId}`, { token: ownerToken }))
        .status,
    ).toBe(404)
    // Mome 软删会把 archived 复位为 false，因此这里按默认 state=NORMAL 查询
    const withDeleted = await call('GET', '/api/v1/memos?showDeleted=true', {
      token: ownerToken,
    })
    expect(
      (withDeleted.body.memos as Array<Record<string, unknown>>).some(
        (item) => item.name === name,
      ),
    ).toBe(true)
  })

  test('rejects empty content and unknown fields', async () => {
    const empty = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('   '),
    })
    expect(empty.status).toBe(400)
    expect(empty.body.code).toBe(3)

    const badVisibility = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('x', { visibility: 'SECRET' }),
    })
    expect(badVisibility.status).toBe(400)
  })

  test('honours a client supplied memoId and createTime', async () => {
    const created = await call('POST', '/api/v1/memos?memoId=my-memo-id', {
      token: ownerToken,
      body: memoBody('custom id', { createTime: '2024-01-01T00:00:00.000Z' }),
    })
    expect(created.status).toBe(200)
    expect(created.body.name).toBe('memos/my-memo-id')
    // 入参接受带小数秒的 RFC3339（宽容解析），回显走 protojson 形态：
    // 秒精度、Z 结尾。带毫秒会让 swift-openapi-runtime 的默认日期解码器
    // 抛错并报废整条响应，见 `memos compat protojson timestamps`。
    expect(created.body.createTime).toBe('2024-01-01T00:00:00Z')
    // 时刻本身没被改变，只是去掉了小数位
    expect(Date.parse(created.body.createTime as string)).toBe(
      Date.parse('2024-01-01T00:00:00.000Z'),
    )

    const duplicate = await call('POST', '/api/v1/memos?memoId=my-memo-id', {
      token: ownerToken,
      body: memoBody('custom id'),
    })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.code).toBe(6)
  })

  test('accepts a clipper-shaped memoId, long content and exposes uid', async () => {
    // web-clipper 的回退 ID 与整页文章剪藏都超出 Mome 原生的 id/正文口径
    const longContent = 'x'.repeat(6000)
    const created = await call(
      'POST',
      '/api/v1/memos?memoId=legacy_1731000000000_abc123',
      { token: ownerToken, body: memoBody(longContent) },
    )
    expect(created.status).toBe(200)
    expect(created.body.name).toBe('memos/legacy_1731000000000_abc123')
    expect(created.body.uid).toBe('legacy_1731000000000_abc123')
    expect((created.body.content as string).length).toBe(6000)
  })

  test('isolates private memos between users and exposes public ones', async () => {
    const priv = await call('POST', '/api/v1/memos', {
      token: otherToken,
      body: memoBody('other private'),
    })
    const pub = await call('POST', '/api/v1/memos', {
      token: otherToken,
      body: memoBody('other public', { visibility: 'PUBLIC' }),
    })
    const privId = (priv.body.name as string).slice('memos/'.length)
    const pubId = (pub.body.name as string).slice('memos/'.length)

    expect(
      (await call('GET', `/api/v1/memos/${privId}`, { token: ownerToken }))
        .status,
    ).toBe(404)
    expect(
      (await call('GET', `/api/v1/memos/${pubId}`, { token: ownerToken }))
        .status,
    ).toBe(200)
    expect((await call('GET', `/api/v1/memos/${pubId}`)).status).toBe(200)
    expect((await call('GET', `/api/v1/memos/${privId}`)).status).toBe(404)

    const list = await call('GET', '/api/v1/memos?pageSize=100', {
      token: ownerToken,
    })
    const names = (list.body.memos as Array<Record<string, unknown>>).map(
      (item) => item.name,
    )
    expect(names).toContain(`memos/${pubId}`)
    expect(names).not.toContain(`memos/${privId}`)

    const anon = await call('GET', '/api/v1/memos?pageSize=100')
    const anonNames = (anon.body.memos as Array<Record<string, unknown>>).map(
      (item) => item.name,
    )
    expect(anonNames).toContain(`memos/${pubId}`)
    expect(anonNames).not.toContain(`memos/${privId}`)
  })

  test('supports the CEL subset used by official clients', async () => {
    await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('cel needle #cel/tag', { visibility: 'PUBLIC' }),
    })

    const byContent = await call(
      'GET',
      `/api/v1/memos?filter=${encodeURIComponent('content.contains("cel needle")')}`,
      { token: ownerToken },
    )
    expect(
      (byContent.body.memos as Array<Record<string, unknown>>).length,
    ).toBe(1)

    // LIKE 元字符必须转义：`%` 不能退化成通配符
    const literalPercent = await call(
      'GET',
      `/api/v1/memos?filter=${encodeURIComponent('content.contains("100%")')}`,
      { token: ownerToken },
    )
    expect(
      (literalPercent.body.memos as Array<Record<string, unknown>>).length,
    ).toBe(0)

    const byTag = await call(
      'GET',
      `/api/v1/memos?filter=${encodeURIComponent('tag in ["cel/tag"]')}`,
      { token: ownerToken },
    )
    expect((byTag.body.memos as Array<Record<string, unknown>>).length).toBe(1)

    const byExists = await call(
      'GET',
      `/api/v1/memos?filter=${encodeURIComponent('tags.exists(t, t == "cel/tag")')}`,
      { token: ownerToken },
    )
    expect((byExists.body.memos as Array<Record<string, unknown>>).length).toBe(
      1,
    )

    const byCreator = await call(
      'GET',
      `/api/v1/memos?filter=${encodeURIComponent(`creator == "users/${OWNER_ID}"`)}`,
      { token: ownerToken },
    )
    expect(
      (byCreator.body.memos as Array<Record<string, unknown>>).length,
    ).toBeGreaterThan(0)

    const byVisibility = await call(
      'GET',
      `/api/v1/memos?filter=${encodeURIComponent('visibility in ["PUBLIC"]')}`,
      { token: ownerToken },
    )
    expect(
      (byVisibility.body.memos as Array<Record<string, unknown>>).length,
    ).toBeGreaterThan(0)

    const byTime = await call(
      'GET',
      `/api/v1/memos?filter=${encodeURIComponent('created_ts > now - duration("1h")')}`,
      { token: ownerToken },
    )
    expect(
      (byTime.body.memos as Array<Record<string, unknown>>).length,
    ).toBeGreaterThan(0)

    for (const filter of [
      'timestamp()',
      'timestamp(1, 2)',
      'timestamp("1")',
      'timestamp(1.5)',
      'duration()',
      'duration("1h", "2h")',
      'duration(1)',
    ]) {
      const invalid = await call(
        'GET',
        `/api/v1/memos?filter=${encodeURIComponent(`created_ts > ${filter}`)}`,
        { token: ownerToken },
      )
      expect(invalid.status).toBe(400)
      expect(invalid.body.code).toBe(3)
    }

    const bySize = await call(
      'GET',
      `/api/v1/memos?filter=${encodeURIComponent('size(content) > 5 && pinned != true')}`,
      { token: ownerToken },
    )
    expect(bySize.status).toBe(200)

    const unsupported = await call(
      'GET',
      `/api/v1/memos?filter=${encodeURIComponent('content.matches(".*")')}`,
      { token: ownerToken },
    )
    expect(unsupported.status).toBe(400)
    expect(unsupported.body.code).toBe(3)

    const badOrder = await call('GET', '/api/v1/memos?orderBy=creator asc', {
      token: ownerToken,
    })
    expect(badOrder.status).toBe(400)
  })

  test('paginates with an opaque pageToken', async () => {
    const first = await call('GET', '/api/v1/memos?pageSize=1', {
      token: ownerToken,
    })
    expect((first.body.memos as unknown[]).length).toBe(1)
    const token = first.body.nextPageToken as string
    expect(token.length).toBeGreaterThan(0)
    const second = await call(
      'GET',
      `/api/v1/memos?pageSize=1&pageToken=${encodeURIComponent(token)}`,
      { token: ownerToken },
    )
    expect((second.body.memos as unknown[]).length).toBe(1)
    expect(
      (second.body.memos as Array<Record<string, unknown>>)[0].name,
    ).not.toBe((first.body.memos as Array<Record<string, unknown>>)[0].name)
    const bad = await call('GET', '/api/v1/memos?pageToken=not-a-token', {
      token: ownerToken,
    })
    expect(bad.status).toBe(400)
  })
})

describe('memos compat social resources', () => {
  test('creates and lists comments as parent-tagged memos', async () => {
    const memo = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('comment target', { visibility: 'PUBLIC' }),
    })
    const memoId = (memo.body.name as string).slice('memos/'.length)

    const created = await call('POST', `/api/v1/memos/${memoId}/comments`, {
      token: otherToken,
      body: { content: 'nice one' },
    })
    expect(created.status).toBe(200)
    expect(created.body.parent).toBe(`memos/${memoId}`)
    expect(created.body.content).toBe('nice one')
    expect(created.body.creator).toBe(`users/${OTHER_ID}`)

    const list = await call('GET', `/api/v1/memos/${memoId}/comments`, {
      token: ownerToken,
    })
    expect((list.body.memos as unknown[]).length).toBe(1)
  })

  test('maps likes to the 👍 reaction', async () => {
    const memo = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('reaction target', { visibility: 'PUBLIC' }),
    })
    const memoId = (memo.body.name as string).slice('memos/'.length)

    const upsert = await call('POST', `/api/v1/memos/${memoId}/reactions`, {
      token: otherToken,
      body: { reaction: { reactionType: '👍' } },
    })
    expect(upsert.status).toBe(200)
    expect(upsert.body.reactionType).toBe('👍')
    expect(upsert.body.name).toBe(`memos/${memoId}/reactions/${OTHER_ID}`)

    // 幂等：重复 upsert 不会取消点赞
    await call('POST', `/api/v1/memos/${memoId}/reactions`, {
      token: otherToken,
      body: { reaction: { reactionType: '👍' } },
    })
    const list = await call('GET', `/api/v1/memos/${memoId}/reactions`, {
      token: ownerToken,
    })
    expect((list.body.reactions as unknown[]).length).toBe(1)

    const unsupported = await call(
      'POST',
      `/api/v1/memos/${memoId}/reactions`,
      { token: otherToken, body: { reaction: { reactionType: '🎉' } } },
    )
    expect(unsupported.status).toBe(501)

    const forbidden = await call(
      'DELETE',
      `/api/v1/memos/${memoId}/reactions/${OWNER_ID}`,
      { token: otherToken },
    )
    expect(forbidden.status).toBe(403)

    const removed = await call(
      'DELETE',
      `/api/v1/memos/${memoId}/reactions/${OTHER_ID}`,
      { token: otherToken },
    )
    expect(removed.status).toBe(200)
    const after = await call('GET', `/api/v1/memos/${memoId}/reactions`, {
      token: ownerToken,
    })
    expect((after.body.reactions as unknown[]).length).toBe(0)
  })

  test('replaces reference relations', async () => {
    const target = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('relation target'),
    })
    const source = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('relation source'),
    })
    const targetId = (target.body.name as string).slice('memos/'.length)
    const sourceId = (source.body.name as string).slice('memos/'.length)

    const set = await call('PATCH', `/api/v1/memos/${sourceId}/relations`, {
      token: ownerToken,
      body: {
        relations: [{ relatedMemo: { name: `memos/${targetId}` } }],
      },
    })
    expect(set.status).toBe(200)

    const list = await call('GET', `/api/v1/memos/${sourceId}/relations`, {
      token: ownerToken,
    })
    const relations = list.body.relations as Array<Record<string, unknown>>
    expect(relations).toHaveLength(1)
    expect((relations[0].relatedMemo as Record<string, unknown>).name).toBe(
      `memos/${targetId}`,
    )
    expect(relations[0].type).toBe('REFERENCE')

    const cleared = await call('PATCH', `/api/v1/memos/${sourceId}/relations`, {
      token: ownerToken,
      body: { relations: [] },
    })
    expect(cleared.status).toBe(200)
    expect(
      (
        await call('GET', `/api/v1/memos/${sourceId}/relations`, {
          token: ownerToken,
        })
      ).body.relations,
    ).toEqual([])
  })
})

describe('memos compat users, instance and PAT', () => {
  test('lists and reads users with email visibility rules', async () => {
    const list = await call('GET', '/api/v1/users?pageSize=100', {
      token: otherToken,
    })
    const users = list.body.users as Array<Record<string, unknown>>
    expect(users.length).toBeGreaterThan(0)
    const owner = users.find((item) => item.name === `users/${OWNER_ID}`)
    expect(owner).toBeTruthy()
    expect(owner!.email).toBeUndefined()

    const self = await call('GET', `/api/v1/users/${OTHER_ID}`, {
      token: otherToken,
    })
    expect(self.body.email).toBe('compat-other@example.com')

    const filtered = await call(
      'GET',
      `/api/v1/users?filter=${encodeURIComponent('username == "compatowner"')}`,
      { token: otherToken },
    )
    expect((filtered.body.users as unknown[]).length).toBe(1)

    const batch = await call('POST', '/api/v1/users:batchGet', {
      token: ownerToken,
      body: { names: [`users/${OWNER_ID}`, `users/${OTHER_ID}`] },
    })
    expect((batch.body.users as unknown[]).length).toBe(2)

    const forbiddenStats = await call(
      'GET',
      `/api/v1/users/${OWNER_ID}:getStats`,
      { token: otherToken },
    )
    expect(forbiddenStats.status).toBe(403)

    const ownStats = await call('GET', `/api/v1/users/${OTHER_ID}:getStats`, {
      token: otherToken,
    })
    expect(ownStats.status).toBe(200)

    const stats = await call('GET', `/api/v1/users/${OWNER_ID}:getStats`, {
      token: ownerToken,
    })
    expect(stats.status).toBe(200)
    expect(stats.body.name).toBe(`users/${OWNER_ID}/stats`)
    expect(stats.body.totalMemoCount).toBeGreaterThan(0)
  })

  test('manages personal access tokens', async () => {
    const created = await call(
      'POST',
      `/api/v1/users/${OWNER_ID}/personalAccessTokens`,
      {
        token: ownerToken,
        body: { description: 'script token', expiresInDays: 30 },
      },
    )
    expect(created.status).toBe(200)
    const token = created.body.token as string
    expect(token.startsWith('memos_pat_')).toBe(true)
    const pat = created.body.personalAccessToken as Record<string, unknown>
    expect(pat.description).toBe('script token')
    expect(typeof pat.expiresAt).toBe('string')

    expect((await call('GET', '/api/v1/auth/me', { token })).status).toBe(200)

    const list = await call(
      'GET',
      `/api/v1/users/${OWNER_ID}/personalAccessTokens`,
      { token: ownerToken },
    )
    expect(
      (list.body.personalAccessTokens as Array<Record<string, unknown>>).some(
        (item) => item.name === pat.name,
      ),
    ).toBe(true)

    const otherUser = await call(
      'POST',
      `/api/v1/users/${OTHER_ID}/personalAccessTokens`,
      { token: ownerToken, body: {} },
    )
    expect(otherUser.status).toBe(403)

    const removed = await call(
      'DELETE',
      `/api/v1/users/${OWNER_ID}/personalAccessTokens/${(pat.name as string).split('/').pop()}`,
      { token: ownerToken },
    )
    expect(removed.status).toBe(200)
    expect((await call('GET', '/api/v1/auth/me', { token })).status).toBe(401)
  })

  test('serves the instance profile', async () => {
    const res = await call('GET', '/api/v1/instance/profile')
    expect(res.status).toBe(200)
    // 兼容层对客户端声明的是 Memos 的 API 版本号，不是产品名
    expect(res.body.version).toBe('0.30.0')
    expect(res.body.needsSetup).toBe(false)
    // 同一进程内其他测试文件也会创建管理员，这里只断言资源名形态
    const admin = res.body.admin as Record<string, unknown>
    expect(admin.name).toMatch(/^users\//)
    expect(admin.email).toBeUndefined()
  })
})

describe('memos compat pagination', () => {
  test('walks every memo exactly once with the opaque pageToken', async () => {
    const created: string[] = []
    for (let i = 0; i < 7; i++) {
      const res = await call('POST', '/api/v1/memos', {
        token: ownerToken,
        body: memoBody(`pagination probe ${i}`, { visibility: 'PRIVATE' }),
      })
      expect(res.status).toBe(200)
      created.push((res.body.name as string).slice('memos/'.length))
    }
    const seen: string[] = []
    let token = ''
    for (let page = 0; page < 20; page++) {
      const query = token
        ? `/api/v1/memos?pageSize=2&pageToken=${encodeURIComponent(token)}`
        : '/api/v1/memos?pageSize=2'
      const res = await call('GET', query, { token: ownerToken })
      expect(res.status).toBe(200)
      for (const memo of res.body.memos as Array<{ name: string }>) {
        seen.push(memo.name.slice('memos/'.length))
      }
      token = res.body.nextPageToken as string
      if (!token) break
    }
    expect(token).toBe('')
    // 不重不漏
    expect(new Set(seen).size).toBe(seen.length)
    for (const id of created) expect(seen).toContain(id)
  })

  test('accepts legacy offset pageTokens and rejects excessive cursors', async () => {
    const legacy = Buffer.from(JSON.stringify({ o: 1 })).toString('base64url')
    const res = await call(
      'GET',
      `/api/v1/memos?pageSize=2&pageToken=${encodeURIComponent(legacy)}`,
      { token: ownerToken },
    )
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.memos)).toBe(true)

    const excessiveOffset = Buffer.from(
      JSON.stringify({ o: 100_001 }),
    ).toString('base64url')
    const excessive = await call(
      'GET',
      `/api/v1/memos?pageToken=${encodeURIComponent(excessiveOffset)}`,
      { token: ownerToken },
    )
    expect(excessive.status).toBe(400)
    expect(excessive.body.code).toBe(3)

    const oversizedToken = 'a'.repeat(4097)
    const oversized = await call(
      'GET',
      `/api/v1/memos?pageToken=${oversizedToken}`,
      { token: ownerToken },
    )
    expect(oversized.status).toBe(400)
    expect(oversized.body.code).toBe(3)
  })

  test('returns a next page token for users when more rows exist', async () => {
    const res = await call('GET', '/api/v1/users?pageSize=1', {
      token: ownerToken,
    })
    expect(res.status).toBe(200)
    expect((res.body.users as unknown[]).length).toBe(1)
    expect(res.body.nextPageToken).not.toBe('')

    const next = await call(
      'GET',
      `/api/v1/users?pageSize=1&pageToken=${encodeURIComponent(res.body.nextPageToken as string)}`,
      { token: ownerToken },
    )
    expect(next.status).toBe(200)
    expect((next.body.users as Array<{ name: string }>)[0].name).not.toBe(
      (res.body.users as Array<{ name: string }>)[0].name,
    )
  })
})

describe('memos compat attachments', () => {
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ])

  /** 与实现同一形状的资源名：`attachments/` + 对象 key 的 base64url */
  function attachmentName(userId: string, ext = 'png'): string {
    const key = `mome/memo-image/${userId}/01J0000000000000000000000.${ext}`
    return `attachments/${Buffer.from(key, 'utf8').toString('base64url')}`
  }

  test('uploads an attachment to the configured bucket and references it from a memo', async () => {
    // loadS3Settings 支持环境变量回落，用本地 stub 顶替 S3：只验证请求形状，不打真实网络
    const puts: Array<{
      path: string
      body: string
      contentType: string | null
    }> = []
    const { server, env } = stubS3(async (request) => {
      puts.push({
        path: new URL(request.url).pathname,
        body: Buffer.from(await request.arrayBuffer()).toString('base64'),
        contentType: request.headers.get('content-type'),
      })
      return new Response(null, { status: 200, headers: { ETag: '"stub"' } })
    })
    process.env.S3_PUBLIC_URL = 'https://cdn.example.com/'

    try {
      const uploaded = await call('POST', '/api/v1/attachments', {
        token: ownerToken,
        body: {
          filename: 'clip.png',
          type: 'image/png',
          content: Buffer.from(pngBytes).toString('base64'),
        },
      })
      expect(uploaded.status).toBe(200)
      const name = uploaded.body.name as string
      expect(name.startsWith('attachments/')).toBe(true)
      expect(uploaded.body.type).toBe('image/png')
      expect(uploaded.body.size).toBe(String(pngBytes.byteLength))

      expect(puts).toHaveLength(1)
      expect(puts[0].contentType).toBe('image/png')
      expect(puts[0].body).toBe(Buffer.from(pngBytes).toString('base64'))
      expect(puts[0].path).toMatch(
        /^\/mome-test\/mome\/memo-image\/compat-owner\/[0-9A-HJKMNP-TV-Z]{26}\.png$/,
      )
      const key = puts[0].path.replace('/mome-test/', '')

      // MoeMemos 等客户端优先用 externalLink 取图；缺了它就会回退拼
      // `{host}/file/{name}/{filename}`，而本服务没有该路由，附件只能 404。
      expect(uploaded.body.externalLink).toBe(`https://cdn.example.com/${key}`)
      expect(Number.isNaN(Date.parse(String(uploaded.body.createTime)))).toBe(
        false,
      )

      const created = await call('POST', '/api/v1/memos', {
        token: ownerToken,
        body: memoBody('clipped page', { attachments: [{ name }] }),
      })
      expect(created.status).toBe(200)
      expect(created.body.content).toBe(
        `clipped page\n\n![image](https://cdn.example.com/${key})`,
      )
      // 正文里的图片 URL 与 externalLink 必须是同一个，客户端两条取图路径才能一致
      expect(created.body.content).toContain(
        uploaded.body.externalLink as string,
      )
    } finally {
      server.stop(true)
      restoreEnv(env, S3_ENV_KEYS)
    }
  })

  test('requires credentials', async () => {
    const res = await call('POST', '/api/v1/attachments', {
      body: { filename: 'a.png', type: 'image/png', content: 'AA==' },
    })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(16)
  })

  test('rejects non-image bytes and malformed base64', async () => {
    const notImage = await call('POST', '/api/v1/attachments', {
      token: ownerToken,
      body: {
        filename: 'note.txt',
        type: 'text/plain',
        content: Buffer.from('just text').toString('base64'),
      },
    })
    expect(notImage.status).toBe(400)
    expect(notImage.body.code).toBe(3)

    const badBase64 = await call('POST', '/api/v1/attachments', {
      token: ownerToken,
      body: { filename: 'a.png', type: 'image/png', content: 'not base64!' },
    })
    expect(badBase64.status).toBe(400)
    expect(badBase64.body.code).toBe(3)
  })

  test('reports FAILED_PRECONDITION when S3 is not configured', async () => {
    const res = await call('POST', '/api/v1/attachments', {
      token: ownerToken,
      body: {
        filename: 'clip.png',
        type: 'image/png',
        content: Buffer.from(pngBytes).toString('base64'),
      },
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(9)
    expect(String(res.body.message)).toContain('S3')
  })

  test('rejects attachment references that are malformed, foreign or unsupported', async () => {
    const malformed = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('broken attachment', {
        attachments: [{ name: 'not-a-resource' }],
      }),
    })
    expect(malformed.status).toBe(400)
    expect(malformed.body.code).toBe(3)

    const foreign = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('foreign attachment', {
        attachments: [{ name: attachmentName(OTHER_ID) }],
      }),
    })
    expect(foreign.status).toBe(403)
    expect(foreign.body.code).toBe(7)

    const unsupported = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('unsupported attachment', {
        attachments: [{ name: attachmentName(OWNER_ID, 'svg') }],
      }),
    })
    expect(unsupported.status).toBe(400)
    expect(unsupported.body.code).toBe(3)
  })

  test('fails the whole create when a referenced attachment cannot be resolved', async () => {
    const content = 'attachment without storage'
    const res = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody(content, {
        attachments: [{ name: attachmentName(OWNER_ID) }],
      }),
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(9)
    // 不伪成功：拒绝的请求不能留下半条 memo
    const list = await call('GET', '/api/v1/memos?pageSize=100', {
      token: ownerToken,
    })
    expect(
      (list.body.memos as Array<Record<string, unknown>>).some(
        (item) => item.content === content,
      ),
    ).toBe(false)
  })

  /** 裸附件 id（资源名尾段）——DeleteAttachment 的路径参数形态 */
  function attachmentToken(userId: string, ext = 'png'): string {
    return attachmentName(userId, ext).slice('attachments/'.length)
  }

  test('deletes the S3 object for an attachment id', async () => {
    const requests: string[] = []
    const { server, env } = stubS3((request) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
      return new Response(null, { status: 204 })
    })

    try {
      const res = await call(
        'DELETE',
        `/api/v1/attachments/${attachmentToken(OWNER_ID)}`,
        { token: ownerToken },
      )
      expect(res.status).toBe(200)
      expect(res.body).toEqual({})
      expect(requests).toEqual([
        `DELETE /mome-test/mome/memo-image/${OWNER_ID}/01J0000000000000000000000.png`,
      ])
    } finally {
      server.stop(true)
      restoreEnv(env, S3_ENV_KEYS)
    }
  })

  test('rejects attachment deletes that are unauthenticated, foreign or malformed', async () => {
    const anonymous = await call(
      'DELETE',
      `/api/v1/attachments/${attachmentToken(OWNER_ID)}`,
    )
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.code).toBe(16)

    // 归属校验先于任何 S3 访问：即使没配 S3 也必须先拒绝别人的附件
    const foreign = await call(
      'DELETE',
      `/api/v1/attachments/${attachmentToken(OTHER_ID)}`,
      { token: ownerToken },
    )
    expect(foreign.status).toBe(403)
    expect(foreign.body.code).toBe(7)

    const malformed = await call('DELETE', '/api/v1/attachments/not-a-key', {
      token: ownerToken,
    })
    expect(malformed.status).toBe(400)
    expect(malformed.body.code).toBe(3)

    const unsupported = await call(
      'DELETE',
      `/api/v1/attachments/${attachmentToken(OWNER_ID, 'svg')}`,
      { token: ownerToken },
    )
    expect(unsupported.status).toBe(400)
    expect(unsupported.body.code).toBe(3)
  })

  test('reports FAILED_PRECONDITION when deleting without configured storage', async () => {
    const res = await call(
      'DELETE',
      `/api/v1/attachments/${attachmentToken(OWNER_ID)}`,
      { token: ownerToken },
    )
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(9)
    expect(String(res.body.message)).toContain('S3')
  })
})

describe('memos compat user settings', () => {
  test('serves the GENERAL setting MoeMemos reads right after login', async () => {
    const res = await call(
      'GET',
      `/api/v1/users/${OWNER_ID}/settings/GENERAL`,
      { token: ownerToken },
    )
    expect(res.status).toBe(200)
    expect(res.body.name).toBe(`users/${OWNER_ID}/settings/GENERAL`)
    expect(res.body.generalSetting).toEqual({ memoVisibility: 'PRIVATE' })
  })

  test('reflects the site-level default visibility', async () => {
    const { db: database, schema } = mods
    const key = 'default_visibility'
    await database
      .delete(schema.siteSettings)
      .where(eq(schema.siteSettings.key, key))
    await database
      .insert(schema.siteSettings)
      .values({ key, value: 'public', updatedAt: new Date() })

    try {
      for (const path of [
        `/api/v1/users/${OWNER_ID}/settings/GENERAL`,
        `/api/v1/users/${OWNER_ID}/settings`,
      ]) {
        const res = await call('GET', path, { token: ownerToken })
        expect(res.status).toBe(200)
        const setting = path.endsWith('GENERAL')
          ? res.body
          : (res.body.settings as Array<Record<string, unknown>>)[0]
        expect(
          (setting.generalSetting as Record<string, unknown>).memoVisibility,
        ).toBe('PUBLIC')
      }
    } finally {
      await database
        .delete(schema.siteSettings)
        .where(eq(schema.siteSettings.key, key))
    }
  })

  test('lists settings in the shape the proto declares', async () => {
    const res = await call('GET', `/api/v1/users/${OWNER_ID}/settings`, {
      token: ownerToken,
    })
    expect(res.status).toBe(200)
    const settings = res.body.settings as Array<Record<string, unknown>>
    expect(settings).toHaveLength(1)
    expect(settings[0].name).toBe(`users/${OWNER_ID}/settings/GENERAL`)
    expect(res.body.nextPageToken).toBe('')
  })

  test('rejects unauthenticated, foreign and unknown settings', async () => {
    const anonymous = await call(
      'GET',
      `/api/v1/users/${OWNER_ID}/settings/GENERAL`,
    )
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.code).toBe(16)

    // OTHER_ID 不是管理员：读别人的设置必须被拒
    const foreign = await call(
      'GET',
      `/api/v1/users/${OWNER_ID}/settings/GENERAL`,
      { token: otherToken },
    )
    expect(foreign.status).toBe(403)
    expect(foreign.body.code).toBe(7)

    const unknown = await call(
      'GET',
      `/api/v1/users/${OWNER_ID}/settings/NOPE`,
      { token: ownerToken },
    )
    expect(unknown.status).toBe(404)
    expect(unknown.body.code).toBe(5)

    const missingUser = await call(
      'GET',
      '/api/v1/users/no-such-user/settings/GENERAL',
      { token: ownerToken },
    )
    expect(missingUser.status).toBe(404)
  })

  test('lets an admin read another users settings but not invent setting ids', async () => {
    // OWNER_ID 在 beforeAll 里被标成管理员：跨用户读取放行
    const asAdmin = await call(
      'GET',
      `/api/v1/users/${OTHER_ID}/settings/GENERAL`,
      { token: ownerToken },
    )
    expect(asAdmin.status).toBe(200)
    expect(asAdmin.body.name).toBe(`users/${OTHER_ID}/settings/GENERAL`)

    // 但"设置名必须存在"这条对管理员同样成立
    const adminUnknown = await call(
      'GET',
      `/api/v1/users/${OTHER_ID}/settings/NOPE`,
      { token: ownerToken },
    )
    expect(adminUnknown.status).toBe(404)
    expect(adminUnknown.body.code).toBe(5)
  })
})

describe('memos compat protojson timestamps', () => {
  /**
   * swift-openapi-runtime 的默认 `dateTranscoder` 是 `.iso8601`，即用 Foundation
   * 默认 `.withInternetDateTime`（不含 `.withFractionalSeconds`）的
   * `ISO8601DateFormatter`。带毫秒的 `toISOString()` 会让它在
   * `InstanceProfile.admin.createTime` 上解码失败，**整条响应**报废，客户端只报
   * `Client encountered an error invoking the operation "…"`。
   * 所以这里把真实响应里的时间戳全扫一遍。
   */
  const RFC3339_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
  const PROTOJSON_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

  function collectTimestamps(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') {
      if (RFC3339_PREFIX.test(value)) out.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) collectTimestamps(item, out)
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) collectTimestamps(item, out)
    }
    return out
  }

  test('never emits fractional seconds on any surface', async () => {
    const created = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('timestamp probe'),
    })
    const memoId = (created.body.name as string).slice('memos/'.length)

    // 客户端在登录前就会打 instance/profile，它是最先撞上该缺陷的地方
    const responses = [
      await call('GET', '/api/v1/instance/profile'),
      await call('GET', '/api/v1/auth/me', { token: ownerToken }),
      await call('GET', '/api/v1/memos?pageSize=5', { token: ownerToken }),
      await call('GET', `/api/v1/memos/${memoId}`, { token: ownerToken }),
      await call('GET', `/api/v1/users/${OWNER_ID}`, { token: ownerToken }),
      await call('GET', `/api/v1/users/${OWNER_ID}:getStats`, {
        token: ownerToken,
      }),
      await call('GET', `/api/v1/users/${OWNER_ID}/personalAccessTokens`, {
        token: ownerToken,
      }),
      created,
    ]

    const seen: string[] = []
    for (const res of responses) {
      expect(res.status).toBe(200)
      const stamps = collectTimestamps(res.body)
      // 每个面上的时间戳都不能被静默漏掉，否则这个测试会假装通过
      expect(stamps.length).toBeGreaterThan(0)
      for (const stamp of stamps) {
        expect(stamp).toMatch(PROTOJSON_TIMESTAMP)
        seen.push(stamp)
      }
    }
    expect(seen.length).toBeGreaterThan(0)
  })

  test('truncates to whole seconds instead of dropping the value', async () => {
    const res = await call('GET', '/api/v1/instance/profile')
    const admin = res.body.admin as Record<string, unknown>
    const createTime = admin.createTime as string
    expect(createTime).toMatch(PROTOJSON_TIMESTAMP)
    // 截断到秒，但仍是一个可解析的真实时刻
    expect(new Date(createTime).getTime() % 1000).toBe(0)
    expect(Number.isNaN(Date.parse(createTime))).toBe(false)
  })
})

describe('memos compat permalink alias', () => {
  test('resolves public memos for everyone, private ones only for the author', async () => {
    const { getMemoPermalink } = await import('../public-core')
    const priv = await call('POST', '/api/v1/memos', {
      token: otherToken,
      body: memoBody('permalink private'),
    })
    const pub = await call('POST', '/api/v1/memos', {
      token: otherToken,
      body: memoBody('permalink public', { visibility: 'PUBLIC' }),
    })
    const privId = (priv.body.name as string).slice('memos/'.length)
    const pubId = (pub.body.name as string).slice('memos/'.length)

    expect(await getMemoPermalink(pubId)).toEqual({ username: 'compatother' })
    expect(await getMemoPermalink(privId)).toBeNull()
    expect(await getMemoPermalink(privId, OTHER_ID)).toEqual({
      username: 'compatother',
    })
    expect(await getMemoPermalink('permalink-missing')).toBeNull()

    await call('DELETE', `/api/v1/memos/${pubId}`, { token: otherToken })
    expect(await getMemoPermalink(pubId)).toBeNull()
  })
})

describe('memos compat unimplemented surface', () => {
  test('returns UNIMPLEMENTED for the attachment and share surface that has no Mome model', async () => {
    for (const [method, path] of [
      ['GET', '/api/v1/attachments'],
      ['GET', '/api/v1/memos/abc/attachments'],
      ['PATCH', '/api/v1/memos/abc/attachments'],
      ['GET', '/api/v1/memos/abc/shares'],
      ['GET', '/api/v1/memos/abc/shares/xyz'],
      ['GET', '/api/v1/shares/xyz/memo'],
      ['GET', '/api/v1/instance/stats'],
    ] as const) {
      const res = await call(method, path, { token: ownerToken })
      expect(res.status).toBe(501)
      expect(res.body.code).toBe(12)
    }
  })

  test('returns UNIMPLEMENTED for unknown paths and 405-free JSON for OPTIONS', async () => {
    const unknown = await call('GET', '/api/v1/nope', { token: ownerToken })
    expect(unknown.status).toBe(501)
    const options = await call('OPTIONS', '/api/v1/memos')
    expect(options.status).toBe(204)
    expect(options.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('memos compat cookie write origin guard', () => {
  // 扩展（chrome-extension:// / moz-extension://）用 PAT 发请求时仍会带上目标站点的
  // cookie，Origin 也不是实例自身——此前这里把 web-clipper 的保存全部误判成 403。
  const extensionOrigin = 'chrome-extension://nebaoebnljalfegiidibihhkebeiklbl'

  test('lets a Bearer client write even when the browser also sends cookies', async () => {
    // 复现 web-clipper 的保存请求：扩展 origin + 站点 cookie + `?memoId=<uuid>`
    const memoId = '4cca3c7d-0900-41db-9d0a-a1dc7382a37a'
    const res = await call('POST', `/api/v1/memos?memoId=${memoId}`, {
      token: ownerToken,
      headers: {
        cookie: 'better-auth.session_token=fake; memos_refresh=fake',
        origin: extensionOrigin,
      },
      body: memoBody('clipper write with cookies'),
    })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe(`memos/${memoId}`)
    expect(res.body.content).toBe('clipper write with cookies')
  })

  test('ignores an invalid Bearer token instead of falling back to the cookie session', async () => {
    const res = await call('POST', '/api/v1/memos', {
      token: 'mome_not-a-real-token',
      headers: { cookie: 'better-auth.session_token=fake' },
      body: memoBody('cookie must not authenticate this'),
    })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(16)
  })

  test('still rejects cookie-authenticated writes from untrusted origins', async () => {
    const res = await call('POST', '/api/v1/memos', {
      headers: {
        cookie: 'better-auth.session_token=fake',
        origin: 'https://evil.example.com',
      },
      body: memoBody('csrf attempt'),
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(7)
  })

  test('does not let non-Bearer authorization bypass cookie origin checks', async () => {
    const res = await call('POST', '/api/v1/memos', {
      headers: {
        authorization: 'Basic dXNlcjpwYXNz',
        cookie: 'better-auth.session_token=fake',
        origin: 'https://evil.example.com',
      },
      body: memoBody('csrf attempt with Basic auth'),
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(7)
  })

  test('keeps the strict check on the cookie-only refresh and signout endpoints', async () => {
    for (const path of ['/api/v1/auth/refresh', '/api/v1/auth/signout']) {
      const res = await call('POST', path, {
        headers: {
          cookie: 'memos_refresh=fake',
          origin: 'https://evil.example.com',
          // 即使带了 Authorization，也只认 refresh cookie：来源必须可信
          authorization: 'Bearer whatever',
        },
      })
      expect(res.status).toBe(403)
      expect(res.body.code).toBe(7)
    }
  })
})

describe('memos compat access control', () => {
  test('rejects writes without credentials', async () => {
    const res = await call('POST', '/api/v1/memos', { body: memoBody('anon') })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(16)
  })

  test('rejects writes to other users memos', async () => {
    const memo = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('owned by owner'),
    })
    const memoId = (memo.body.name as string).slice('memos/'.length)
    const res = await call('PATCH', `/api/v1/memos/${memoId}`, {
      token: otherToken,
      body: { content: 'hijack' },
    })
    expect(res.status).toBe(404)
  })

  test('never exposes unreadable relation targets', async () => {
    const marker = 'RELATION_ACL_PRIVATE_MARKER'
    const secret = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody(`${marker} private target`, { visibility: 'PRIVATE' }),
    })
    const archived = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('ARCHIVED_TARGET_MARKER', { visibility: 'PUBLIC' }),
    })
    const source = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('public source', { visibility: 'PUBLIC' }),
    })
    const secretId = (secret.body.name as string).slice('memos/'.length)
    const archivedId = (archived.body.name as string).slice('memos/'.length)
    const sourceId = (source.body.name as string).slice('memos/'.length)
    expect(
      (
        await call('PATCH', `/api/v1/memos/${archivedId}`, {
          token: ownerToken,
          body: { state: 'ARCHIVED' },
        })
      ).status,
    ).toBe(200)
    const linked = await call('PATCH', `/api/v1/memos/${sourceId}/relations`, {
      token: ownerToken,
      body: {
        relations: [
          { relatedMemo: { name: `memos/${secretId}` } },
          { relatedMemo: { name: `memos/${archivedId}` } },
        ],
      },
    })
    expect(linked.status).toBe(200)

    // 匿名与他人：详情、列表、relations 三条输出路径都不能带出不可读目标
    for (const token of [undefined, otherToken]) {
      for (const path of [
        `/api/v1/memos/${sourceId}`,
        `/api/v1/memos/${sourceId}/relations`,
        '/api/v1/memos',
      ]) {
        const res = await call('GET', path, { token })
        expect(res.status).toBe(200)
        const body = JSON.stringify(res.body)
        expect(body).not.toContain(marker)
        expect(body).not.toContain('ARCHIVED_TARGET_MARKER')
        expect(body).not.toContain(secretId)
      }
    }

    // 本人仍然能看到自己的关联目标
    const own = await call('GET', `/api/v1/memos/${sourceId}/relations`, {
      token: ownerToken,
    })
    expect(JSON.stringify(own.body)).toContain(marker)
  })
})

describe('memos compat pat exchange', () => {
  test('exchanges an own API key for a working memos_pat_', async () => {
    const { token: sourceKey } = await mods.keys.createApiKeyForUser(
      OWNER_ID,
      'exchange source',
    )
    expect(sourceKey.startsWith('mome_')).toBe(true)

    const exchanged = await mods.keys.exchangeApiKeyForMemosPatForUser(
      OWNER_ID,
      sourceKey,
      { description: 'MoeMemos' },
    )
    expect(exchanged.token.startsWith('memos_pat_')).toBe(true)
    expect(exchanged.key.name).toBe('MoeMemos')

    const me = await call('GET', '/api/v1/auth/me', {
      token: exchanged.token,
    })
    expect(me.status).toBe(200)
    expect((me.body.user as Record<string, unknown>).name).toBe(
      `users/${OWNER_ID}`,
    )
  })

  test('rejects foreign, unknown and already expired credentials', async () => {
    const { token: otherKey } = await mods.keys.createApiKeyForUser(
      OTHER_ID,
      'other source',
    )
    await expect(
      mods.keys.exchangeApiKeyForMemosPatForUser(OWNER_ID, otherKey),
    ).rejects.toThrow('不属于当前账户')
    await expect(
      mods.keys.exchangeApiKeyForMemosPatForUser(OWNER_ID, 'mome_unknown'),
    ).rejects.toThrow('无效、已过期或已撤销')

    const { token: ownKey } = await mods.keys.createApiKeyForUser(
      OWNER_ID,
      'expiry source',
    )
    await expect(
      mods.keys.exchangeApiKeyForMemosPatForUser(OWNER_ID, ownKey, {
        expiresAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow('过期时间必须晚于当前时间')
  })
})

describe('memos compat export surface', () => {
  test('exposes the documented handler only', async () => {
    expect(typeof mods.handlers.handleMemosCompat).toBe('function')
    const rows = await mods.db
      .select()
      .from(mods.schema.memos)
      .where(eq(mods.schema.memos.id, 'my-memo-id'))
    expect(rows).toHaveLength(1)
  })
})

describe('memos compat bearer token kinds', () => {
  test('accepts mome_ API keys as well as memos_pat_ tokens', async () => {
    const { token } = await mods.keys.createApiKeyForUser(OWNER_ID, 'mome key')
    expect(token.startsWith('mome_')).toBe(true)
    const me = await call('GET', '/api/v1/auth/me', { token })
    expect(me.status).toBe(200)
    expect((me.body.user as Record<string, unknown>).name).toBe(
      `users/${OWNER_ID}`,
    )
    await mods.db
      .delete(mods.schema.apiKeys)
      .where(eq(mods.schema.apiKeys.id, (await keyIdOf(token)) ?? ''))
  })

  async function keyIdOf(token: string): Promise<string | null> {
    const { hashApiKeyToken } = await import('#/lib/api-keys')
    const row = await mods.db.query.apiKeys.findFirst({
      where: eq(mods.schema.apiKeys.keyHash, hashApiKeyToken(token)),
      columns: { id: true },
    })
    return row?.id ?? null
  }
})

describe('memos compat update mask validation', () => {
  test('rejects a body name that disagrees with the path', async () => {
    const created = await call('POST', '/api/v1/memos', {
      token: ownerToken,
      body: memoBody('mask target'),
    })
    const memoId = (created.body.name as string).slice('memos/'.length)
    const res = await call('PATCH', `/api/v1/memos/${memoId}`, {
      token: ownerToken,
      body: { name: 'memos/some-other-memo', content: 'x' },
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(3)
  })
})
