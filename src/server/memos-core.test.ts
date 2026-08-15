import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createClient } from '@libsql/client'
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

async function loadDatabase() {
  return import('#/db')
}

async function loadSchema() {
  return import('#/db/schema')
}

let core: Awaited<ReturnType<typeof loadCore>>
let interactions: Awaited<ReturnType<typeof loadInteractions>>
let notificationCore: Awaited<ReturnType<typeof loadNotificationCore>>
let database: Awaited<ReturnType<typeof loadDatabase>>['db']
let users: Awaited<ReturnType<typeof loadSchema>>['user']

const OWNER_ID = 'test-owner'
const ACTOR_ID = 'test-actor'

beforeAll(async () => {
  const client = createClient({ url: process.env.DATABASE_URL! })
  await migrate(drizzle(client), {
    migrationsFolder: join(import.meta.dir, '../../drizzle'),
  })
  await client.close()

  ;({ db: database } = await loadDatabase())
  ;({ user: users } = await loadSchema())
  core = await loadCore()
  interactions = await loadInteractions()
  notificationCore = await loadNotificationCore()

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
})
