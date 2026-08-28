import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { createClient } from '@libsql/client'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'

const dbPath = `/private/tmp/mome-core-${process.pid}.db`
process.env.DATABASE_URL = `file:${dbPath}`

async function loadCore() {
  return import('./memos-core')
}

async function loadInteractions() {
  return import('./interactions-core')
}

async function loadNotificationCore() {
  return import('./notifications-core')
}

async function loadAdminCore() {
  return import('./admin-core')
}

async function loadDatabase() {
  return import('#/db')
}

async function loadSchema() {
  return import('#/db/schema')
}

let core: Awaited<ReturnType<typeof loadCore>>
let interactions: Awaited<ReturnType<typeof loadInteractions>>
let notificationCore: Awaited<ReturnType<typeof loadNotificationCore>>
let adminCore: Awaited<ReturnType<typeof loadAdminCore>>
let database: Awaited<ReturnType<typeof loadDatabase>>['db']
let users: Awaited<ReturnType<typeof loadSchema>>['user']
let admins: Awaited<ReturnType<typeof loadSchema>>['adminUsers']
let apiKeyRecords: Awaited<ReturnType<typeof loadSchema>>['apiKeys']
let settings: Awaited<ReturnType<typeof loadSchema>>['siteSettings']
let verifications: Awaited<ReturnType<typeof loadSchema>>['verification']
let memosTable: Awaited<ReturnType<typeof loadSchema>>['memos']
let memoRepostRecords: Awaited<ReturnType<typeof loadSchema>>['memoReposts']
let tagRecords: Awaited<ReturnType<typeof loadSchema>>['tags']

const OWNER_ID = 'test-owner'
const ACTOR_ID = 'test-actor'

beforeAll(async () => {
  const client = createClient({ url: process.env.DATABASE_URL! })
  await migrate(drizzle(client), {
    migrationsFolder: join(import.meta.dir, '../../drizzle'),
  })
  await client.close()

  ;({ db: database } = await loadDatabase())
  ;({
    adminUsers: admins,
    apiKeys: apiKeyRecords,
    memoReposts: memoRepostRecords,
    memos: memosTable,
    siteSettings: settings,
    tags: tagRecords,
    user: users,
    verification: verifications,
  } = await loadSchema())
  core = await loadCore()
  interactions = await loadInteractions()
  notificationCore = await loadNotificationCore()
  adminCore = await loadAdminCore()

  const now = new Date()
  await database.insert(users).values([
    {
      id: OWNER_ID,
      name: 'Owner',
      email: 'owner@example.com',
      username: 'owner',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: ACTOR_ID,
      name: 'Actor',
      email: 'actor@example.com',
      username: 'actor',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  ])
})

afterAll(async () => {
  await Promise.all(
    ['', '-shm', '-wal'].map((suffix) =>
      unlink(`${dbPath}${suffix}`).catch(() => undefined),
    ),
  )
})

describe('memo core', () => {
  test('deduplicates retried creates by client id', async () => {
    const clientId = crypto.randomUUID()
    const first = await core.createMemoForUser(OWNER_ID, 'idempotent memo', {
      clientId,
    })
    const retried = await core.createMemoForUser(OWNER_ID, 'idempotent memo', {
      clientId,
    })

    expect(retried.id).toBe(first.id)
    const listed = await core.listMemosForUser(OWNER_ID, {
      q: 'idempotent memo',
    })
    expect(listed.items).toHaveLength(1)
  })

  test('deduplicates concurrent client ids and tag creation', async () => {
    const clientId = crypto.randomUUID()
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        core.createMemoForUser(OWNER_ID, 'concurrent #same/tag', { clientId }),
      ),
    )

    expect(new Set(results.map((memo) => memo.id)).size).toBe(1)
    expect(new Set(results.map((memo) => memo.tags[0]?.id)).size).toBe(1)
    expect(
      (await core.listMemosForUser(OWNER_ID, { q: 'concurrent' })).items,
    ).toHaveLength(1)
  })

  test('keeps deleted idempotent creates deleted on retry', async () => {
    const clientId = crypto.randomUUID()
    const first = await core.createMemoForUser(OWNER_ID, 'deleted retry', {
      clientId,
    })
    await core.deleteMemoForUser(OWNER_ID, first.id)
    const retried = await core.createMemoForUser(OWNER_ID, 'deleted retry', {
      clientId,
    })

    expect(retried.id).toBe(first.id)
    expect(retried.deletedAt).not.toBeNull()
  })

  test('hides soft-deleted memos and restores them', async () => {
    const memo = await core.createMemoForUser(OWNER_ID, 'soft delete target')
    expect((await core.deleteMemoForUser(OWNER_ID, memo.id)).deleted).toBe(true)

    const active = await core.listMemosForUser(OWNER_ID, {
      q: 'soft delete target',
    })
    const deleted = await core.listMemosForUser(OWNER_ID, {
      q: 'soft delete target',
      filter: 'deleted',
    })
    expect(active.items).toHaveLength(0)
    expect(deleted.items.map((item) => item.id)).toContain(memo.id)

    expect(
      (await core.restoreDeletedMemoForUser(OWNER_ID, memo.id)).restored,
    ).toBe(true)
    expect((await core.getMemoForUser(OWNER_ID, memo.id)).deletedAt).toBeNull()
  })

  test('records and restores edit versions', async () => {
    const memo = await core.createMemoForUser(OWNER_ID, 'version one')
    await core.updateMemoForUser(OWNER_ID, memo.id, 'version two')

    const versions = await core.listMemoVersionsForUser(OWNER_ID, memo.id)
    expect(versions[0]?.content).toBe('version one')
    const restored = await core.restoreMemoVersionForUser(
      OWNER_ID,
      memo.id,
      versions[0].id,
    )
    expect(restored.content).toBe('version one')
    expect(await core.listMemoVersionsForUser(OWNER_ID, memo.id)).toHaveLength(
      2,
    )
  })

  test('patches every memo field in one core operation', async () => {
    const memo = await core.createMemoForUser(OWNER_ID, 'patch before #old')
    const patched = await core.patchMemoForUser(OWNER_ID, memo.id, {
      content: 'patch after #new',
      visibility: 'public',
      pinned: true,
      archived: true,
    })

    expect(patched).toEqual(
      expect.objectContaining({
        content: 'patch after #new',
        visibility: 'public',
        pinned: true,
        archived: true,
      }),
    )
    expect(patched.tags.map((tag) => tag.name)).toEqual(['new'])
    expect(
      (await core.listMemoVersionsForUser(OWNER_ID, memo.id))[0]?.content,
    ).toBe('patch before #old')
  })

  test('keeps page tags scoped and loads memo connections', async () => {
    const target = await core.createMemoForUser(
      OWNER_ID,
      'target #batch-target',
    )
    const source = await core.createMemoForUser(
      OWNER_ID,
      `source #batch-source [[memo:${target.id}]]`,
    )

    const listed = await core.listMemosForUser(OWNER_ID, { limit: 50 })
    expect(listed.items.find((item) => item.id === target.id)?.tags).toEqual([
      expect.objectContaining({ name: 'batch-target' }),
    ])
    expect(listed.items.find((item) => item.id === source.id)?.tags).toEqual([
      expect.objectContaining({ name: 'batch-source' }),
    ])

    const connections = await core.getMemoConnectionsForUser(
      OWNER_ID,
      source.id,
    )
    expect(connections.outgoing.map((item) => item.id)).toContain(target.id)
  })

  test('batch imports tags and links with database-winning tag ids', async () => {
    const target = await core.createMemoForUser(OWNER_ID, 'import target')
    await Promise.all([
      core.importMemosForUser(OWNER_ID, [
        {
          content: `import batch one #shared/root [[memo:${target.id}]]`,
          visibility: 'private',
          pinned: false,
          archived: false,
        },
      ]),
      core.importMemosForUser(OWNER_ID, [
        {
          content: 'import batch two #shared/root',
          visibility: 'private',
          pinned: false,
          archived: false,
        },
      ]),
    ])

    const one = (await core.listMemosForUser(OWNER_ID, { q: 'batch one' }))
      .items[0]
    const two = (await core.listMemosForUser(OWNER_ID, { q: 'batch two' }))
      .items[0]
    expect(one.tags[0]?.id).toBe(two.tags[0]?.id)
    expect(
      (await core.getMemoConnectionsForUser(OWNER_ID, one.id)).outgoing.map(
        (memo) => memo.id,
      ),
    ).toContain(target.id)
  })

  test('creates and removes inbound like notifications', async () => {
    const memo = await core.createMemoForUser(OWNER_ID, 'public notification', {
      visibility: 'public',
    })
    const liked = await interactions.toggleLikeForUser(ACTOR_ID, memo.id)
    expect(liked.counts.likes).toBe(1)
    expect(
      (await interactions.loadViewerStates([memo.id], ACTOR_ID)).get(memo.id),
    ).toEqual(expect.objectContaining({ liked: true }))
    const created = await notificationCore.listNotificationsForUser(OWNER_ID)
    expect(created.items.some((item) => item.memo.id === memo.id)).toBe(true)
    expect(
      await notificationCore.countUnreadNotificationsForUser(OWNER_ID),
    ).toBe(1)

    await core.deleteMemoForUser(OWNER_ID, memo.id)
    expect(
      await notificationCore.countUnreadNotificationsForUser(OWNER_ID),
    ).toBe(0)
    await core.restoreDeletedMemoForUser(OWNER_ID, memo.id)

    const unliked = await interactions.toggleLikeForUser(ACTOR_ID, memo.id)
    expect(unliked.counts.likes).toBe(0)
    const removed = await notificationCore.listNotificationsForUser(OWNER_ID)
    expect(removed.items.some((item) => item.memo.id === memo.id)).toBe(false)
  })

  test('aggregates every interaction count', async () => {
    const memo = await core.createMemoForUser(OWNER_ID, 'count interactions', {
      visibility: 'public',
    })

    await interactions.toggleLikeForUser(ACTOR_ID, memo.id)
    await interactions.toggleFavoriteForUser(ACTOR_ID, memo.id)
    await interactions.toggleRepostForUser(ACTOR_ID, memo.id)
    const added = await interactions.addCommentForUser(
      ACTOR_ID,
      memo.id,
      'counted comment',
    )

    const expected = { likes: 1, favorites: 1, comments: 1, reposts: 1 }
    expect(added.counts).toEqual(expected)
    expect((await interactions.loadMemoCounts([memo.id])).get(memo.id)).toEqual(
      expected,
    )

    const deleted = await interactions.deleteCommentForUser(
      ACTOR_ID,
      added.comment.id,
    )
    expect(deleted.counts).toEqual({ ...expected, comments: 0 })
  })

  test('rejects new interactions after a memo becomes private', async () => {
    const memo = await core.createMemoForUser(OWNER_ID, 'private target')
    const attempts = await Promise.allSettled([
      interactions.toggleLikeForUser(ACTOR_ID, memo.id),
      interactions.toggleFavoriteForUser(ACTOR_ID, memo.id),
      interactions.toggleRepostForUser(ACTOR_ID, memo.id),
      interactions.addCommentForUser(ACTOR_ID, memo.id, 'blocked'),
    ])

    expect(attempts.every((result) => result.status === 'rejected')).toBe(true)
    expect((await interactions.loadMemoCounts([memo.id])).get(memo.id)).toEqual(
      {
        likes: 0,
        favorites: 0,
        comments: 0,
        reposts: 0,
      },
    )
  })

  test('keeps exactly one admin during concurrent claim and removal', async () => {
    await database.delete(admins)
    const claimed = await Promise.all([
      adminCore.claimFirstAdminForUser(OWNER_ID),
      adminCore.claimFirstAdminForUser(ACTOR_ID),
    ])
    expect(claimed.filter(Boolean)).toHaveLength(1)

    await database
      .insert(admins)
      .values({
        userId: claimed[0] ? ACTOR_ID : OWNER_ID,
        createdAt: new Date(),
      })
      .onConflictDoNothing()
    const removed = await Promise.allSettled([
      adminCore.removeAdminForUser(OWNER_ID),
      adminCore.removeAdminForUser(ACTOR_ID),
    ])
    expect(
      removed.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1)
    expect(await database.select().from(admins)).toHaveLength(1)
  })

  test('atomically consumes Better Auth verification values', async () => {
    const identifier = `audit-consume-${crypto.randomUUID()}`
    const now = new Date()
    await database.insert(verifications).values({
      id: crypto.randomUUID(),
      identifier,
      value: 'single-use',
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
    })
    const { auth } = await import('#/lib/auth')
    const authContext = await auth.$context
    const consumed = await Promise.all(
      Array.from({ length: 20 }, () =>
        authContext.internalAdapter.consumeVerificationValue(identifier),
      ),
    )

    expect(consumed.filter(Boolean)).toHaveLength(1)
  })

  test('shares rate-limit counters through the database', async () => {
    const { rateLimitOrThrow } = await import('./rate-limit')
    const key = `audit-rate-${crypto.randomUUID()}`
    await rateLimitOrThrow(key, { window: 60, max: 2 })
    await rateLimitOrThrow(key, { window: 60, max: 2 })
    await expect(rateLimitOrThrow(key, { window: 60, max: 2 })).rejects.toThrow(
      '请求过于频繁',
    )
  })

  test('uses the database-backed Better Auth rate limiter', async () => {
    const { auth } = await import('#/lib/auth')
    const response = await auth.handler(
      new Request('http://localhost:3000/api/auth/ok', {
        headers: { 'x-forwarded-for': '127.0.0.1' },
      }),
    )
    expect(response.status).toBe(200)
  })

  test('reads site setting changes without a stale process cache', async () => {
    const { loadSiteSettings } = await import('./settings-core')
    await database
      .insert(settings)
      .values({ key: 'site_name', value: 'before', updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: 'before', updatedAt: new Date() },
      })
    expect((await loadSiteSettings()).name).toBe('before')
    await database
      .update(settings)
      .set({ value: 'after', updatedAt: new Date() })
      .where(eq(settings.key, 'site_name'))
    expect((await loadSiteSettings()).name).toBe('after')
  })

  test('throttles API key last-used writes', async () => {
    const { authenticateApiKeyToken, createApiKeyForUser } =
      await import('./api-keys-core')
    const created = await createApiKeyForUser(OWNER_ID, 'audit key')
    await authenticateApiKeyToken(created.token)
    const first = await database.query.apiKeys.findFirst({
      where: eq(apiKeyRecords.id, created.key.id),
    })
    await Bun.sleep(5)
    await authenticateApiKeyToken(created.token)
    const second = await database.query.apiKeys.findFirst({
      where: eq(apiKeyRecords.id, created.key.id),
    })
    expect(second?.lastUsedAt?.getTime()).toBe(first?.lastUsedAt?.getTime())
  })

  test('rolls back Better Auth sign-up when account creation fails', async () => {
    const email = `rollback-${crypto.randomUUID()}@example.com`
    await database.run(sql`
      CREATE TRIGGER audit_fail_account
      BEFORE INSERT ON account
      BEGIN
        SELECT RAISE(FAIL, 'audit account failure');
      END
    `)
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { auth } = await import('#/lib/auth')
      const response = await auth.handler(
        new Request('http://localhost:3000/api/auth/sign-up/email', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://localhost:3000',
          },
          body: JSON.stringify({
            name: 'Rollback',
            username: `rollback_${crypto.randomUUID().slice(0, 8)}`,
            email,
            password: 'password-for-audit',
          }),
        }),
      )
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(
        await database.query.user.findFirst({ where: eq(users.email, email) }),
      ).toBeUndefined()
    } finally {
      errorSpy.mockRestore()
      await database.run(sql`DROP TRIGGER audit_fail_account`)
    }
  })

  test('counts distinct days for high-frequency streaks', async () => {
    const today = new Date()
    const yesterday = new Date(today.getTime() - 86_400_000)
    const items = Array.from({ length: 3650 }, (_, index) => ({
      content: `high frequency ${index}`,
      visibility: 'private' as const,
      pinned: false,
      archived: false,
      createdAt: today.toISOString(),
    }))
    items.push({
      content: 'high frequency yesterday',
      visibility: 'private',
      pinned: false,
      archived: false,
      createdAt: yesterday.toISOString(),
    })
    await core.importMemosForUser(OWNER_ID, items)

    expect((await core.getStatsForUser(OWNER_ID, 0)).streak).toBe(2)
  })

  test('round-trips tags through export and import', async () => {
    const memo = await core.createMemoForUser(
      OWNER_ID,
      'export source #rust/ownership',
    )
    const exported = await core.exportMemosForUser(OWNER_ID)
    const source = exported.find((item) => item.id === memo.id)
    // 导出还原完整层级路径而非叶子名
    expect(source?.tags).toContain('rust/ownership')

    // 无 id 导入：显式 tags（正文无 #hashtag）也应还原，且父标签入库
    const imported = await core.importMemosForUser(OWNER_ID, [
      {
        content: 'plain content without hashtag',
        visibility: 'private',
        pinned: false,
        archived: false,
        tags: ['rust/ownership'],
      },
    ])
    expect(imported.imported).toBe(1)
    const restored = (
      await core.listMemosForUser(OWNER_ID, { q: 'plain content' })
    ).items[0]
    expect(restored.tags.map((tag) => tag.name)).toContain('ownership')
    const parent = await database.query.tags.findFirst({
      where: eq(tagRecords.name, 'rust'),
    })
    expect(parent).toBeDefined()
    const leaf = await database.query.tags.findFirst({
      where: eq(tagRecords.name, 'ownership'),
    })
    expect(leaf?.parentId).toBe(parent?.id)
  })
})

describe('merged timeline pagination', () => {
  /**
   * 布置交错流：6 条自己的 memo（含私密）+ 4 条对 actor 公开 memo 的转发，
   * 时间互相交错。每个用例使用独立用户，避免公开数据串进对方断言。
   */
  async function seedFixture(prefix: string) {
    const now = new Date()
    const ownerId = `${prefix}-owner`
    const actorId = `${prefix}-actor`
    await database
      .insert(users)
      .values([
        {
          id: ownerId,
          name: 'Page Owner',
          email: `${prefix}-owner@example.com`,
          username: `${prefix}-owner`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: actorId,
          name: 'Page Actor',
          email: `${prefix}-actor@example.com`,
          username: `${prefix}-actor`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .onConflictDoNothing()

    const base = Date.now() - 60 * 60 * 1000
    for (let i = 0; i < 6; i++) {
      const at = new Date(base + i * 1000)
      await database.insert(memosTable).values({
        id: `${prefix}-memo-${i}`,
        userId: ownerId,
        content: `pagination memo ${i} ${prefix}`,
        visibility: i % 2 === 0 ? 'public' : 'private',
        createdAt: at,
        updatedAt: at,
      })
    }
    for (let i = 0; i < 4; i++) {
      const at = new Date(base + i * 1000 + 500)
      const memoId = `${prefix}-actor-${i}`
      await database.insert(memosTable).values({
        id: memoId,
        userId: actorId,
        content: `actor memo ${i} ${prefix}`,
        visibility: 'public',
        createdAt: at,
        updatedAt: at,
      })
      await database.insert(memoRepostRecords).values({
        memoId,
        userId: ownerId,
        createdAt: at,
      })
    }
    return { ownerId }
  }

  test('home feed pages through memos and reposts without duplicates', async () => {
    const { ownerId } = await seedFixture('home')
    const timeline = await import('./timeline-core')

    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const res = await timeline.listHomeFeedForUser(
        ownerId,
        { cursor, limit: 3 },
        ownerId,
      )
      for (const item of res.items) {
        seen.push(
          item.kind === 'repost'
            ? `repost:${item.memo.id}`
            : `memo:${item.memo.id}`,
        )
      }
      if (!res.nextCursor) break
      cursor = res.nextCursor
    }

    expect(seen).toHaveLength(10)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen[0]).toBe('memo:home-memo-5')
  })

  test('public profile feed pages without duplicates', async () => {
    await seedFixture('profile')
    const publicCore = await import('./public-core')

    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const res = await publicCore.listPublicFeed('profile-owner', {
        cursor,
        limit: 3,
      })
      for (const item of res.items) {
        seen.push(
          item.kind === 'repost'
            ? `repost:${item.memo.id}`
            : `memo:${item.memo.id}`,
        )
      }
      if (!res.nextCursor) break
      cursor = res.nextCursor
    }

    // 主页只含 profile-owner 的 3 条公开 memo + 4 条转发
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(seen.length)
  })
})
