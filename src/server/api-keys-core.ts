import { and, desc, eq, isNull, lt, or } from 'drizzle-orm'

import { db } from '#/db'
import { apiKeys, user } from '#/db/schema'
import {
  apiKeyPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
} from '#/lib/api-keys'
import { ulid } from '#/lib/ulid'

export interface ApiKeyItem {
  id: string
  name: string
  keyPrefix: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

export interface ApiKeyUser {
  id: string
  username: string
  name: string
  email: string
  image: string | null
  bio: string | null
  createdAt: string
}

function toApiKeyItem(key: typeof apiKeys.$inferSelect): ApiKeyItem {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    expiresAt: key.expiresAt?.toISOString() ?? null,
  }
}

export async function createApiKeyForUser(
  userId: string,
  name: string,
  opts: { expiresAt?: Date | null } = {},
): Promise<{ key: ApiKeyItem; token: string }> {
  const token = generateApiKeyToken()
  const key = {
    id: ulid(),
    userId,
    name,
    keyHash: hashApiKeyToken(token),
    keyPrefix: apiKeyPrefix(token),
    createdAt: new Date(),
    lastUsedAt: null,
    expiresAt: opts.expiresAt ?? null,
    revokedAt: null,
  }
  await db.insert(apiKeys).values(key)
  return { key: toApiKeyItem(key), token }
}

export async function listApiKeysForUser(
  userId: string,
): Promise<ApiKeyItem[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt))
  return rows.map(toApiKeyItem)
}

export async function revokeApiKeyForUser(
  userId: string,
  id: string,
): Promise<void> {
  const updated = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, id),
        eq(apiKeys.userId, userId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning()
  if (updated.length === 0) {
    throw new Error('API key not found')
  }
}

/** 校验 Bearer token；无效/过期/已撤销返回 null */
export async function authenticateApiKeyToken(
  token: string,
): Promise<ApiKeyUser | null> {
  const hash = hashApiKeyToken(token)
  const rows = await db
    .select({ key: apiKeys, user })
    .from(apiKeys)
    .innerJoin(user, eq(apiKeys.userId, user.id))
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .limit(1)
  const row = rows.at(0)
  if (!row) return null
  if (row.key.expiresAt && row.key.expiresAt.getTime() <= Date.now()) {
    return null
  }
  const now = new Date()
  const cutoff = new Date(now.getTime() - 10 * 60 * 1000)
  if (!row.key.lastUsedAt || row.key.lastUsedAt <= cutoff) {
    try {
      await db
        .update(apiKeys)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(apiKeys.id, row.key.id),
            or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, cutoff)),
          ),
        )
    } catch (error) {
      console.error('[api-key] 更新 lastUsedAt 失败', {
        keyId: row.key.id,
        error,
      })
    }
  }
  return {
    id: row.user.id,
    username: row.user.username,
    name: row.user.name,
    email: row.user.email,
    image: row.user.image,
    bio: row.user.bio ?? null,
    createdAt: row.user.createdAt.toISOString(),
  }
}
