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

    const refresh = await call('POST', '/api/v1/auth/refresh', {
      headers: { cookie: cookie.split(';')[0] },
    })
    expect(refresh.status).toBe(200)
    const refreshed = refresh.body.accessToken as string
    expect(refreshed).not.toBe(accessToken)
    expect(
      (await call('GET', '/api/v1/auth/me', { token: refreshed })).status,
    ).toBe(200)

    const signout = await call('POST', '/api/v1/auth/signout')
    expect(signout.status).toBe(200)
    expect(signout.headers.get('set-cookie')).toContain('Max-Age=0')
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
    expect(created.body.createTime).toBe('2024-01-01T00:00:00.000Z')

    const duplicate = await call('POST', '/api/v1/memos?memoId=my-memo-id', {
      token: ownerToken,
      body: memoBody('custom id'),
    })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.code).toBe(6)
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

    const stats = await call(`GET`, `/api/v1/users/${OWNER_ID}:getStats`, {
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
    expect(res.body.version).toBe('mome')
    expect(res.body.needsSetup).toBe(false)
    // 同一进程内其他测试文件也会创建管理员，这里只断言资源名形态
    expect((res.body.admin as Record<string, unknown>).name).toMatch(/^users\//)
  })
})

describe('memos compat unimplemented surface', () => {
  test('returns UNIMPLEMENTED for attachments and shares', async () => {
    for (const [method, path] of [
      ['GET', '/api/v1/attachments'],
      ['POST', '/api/v1/attachments'],
      ['GET', '/api/v1/memos/abc/attachments'],
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
