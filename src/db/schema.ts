import { relations, sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

// ── better-auth 四表（由 @better-auth/cli 生成）──────────────
import { account, session, user, verification } from './auth-schema.ts'

export * from './auth-schema.ts'
export { account, session, user, verification }

// ── memos ────────────────────────────────────────────────
export const memos = sqliteTable(
  'memos',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    // 公开页可见性：public 可被任何人通过 /@username/:id 访问
    visibility: text('visibility', { enum: ['public', 'private'] })
      .notNull()
      .default('private'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    globalPinned: integer('global_pinned', { mode: 'boolean' })
      .notNull()
      .default(false),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('memos_user_created_idx').on(t.userId, t.createdAt),
    index('memos_user_pinned_idx').on(t.userId, t.pinned),
    uniqueIndex('memos_user_pinned_unique_idx')
      .on(t.userId)
      .where(sql`${t.pinned} = 1`),
    uniqueIndex('memos_global_pinned_unique_idx')
      .on(t.globalPinned)
      .where(sql`${t.globalPinned} = 1`),
    index('memos_user_visibility_created_idx').on(
      t.userId,
      t.visibility,
      t.createdAt,
    ),
  ],
)

// ── 互动：点赞 / 收藏 / 评论 / 转发 ─────────────────────
export const memoLikes = sqliteTable(
  'memo_likes',
  {
    memoId: text('memo_id')
      .notNull()
      .references(() => memos.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.memoId, t.userId] }),
    index('memo_likes_memo_idx').on(t.memoId),
    index('memo_likes_user_idx').on(t.userId),
  ],
)

export const memoFavorites = sqliteTable(
  'memo_favorites',
  {
    memoId: text('memo_id')
      .notNull()
      .references(() => memos.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.memoId, t.userId] }),
    index('memo_favorites_memo_idx').on(t.memoId),
    index('memo_favorites_user_idx').on(t.userId),
  ],
)

export const memoComments = sqliteTable(
  'memo_comments',
  {
    id: text('id').primaryKey(),
    memoId: text('memo_id')
      .notNull()
      .references(() => memos.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('memo_comments_memo_created_idx').on(t.memoId, t.createdAt),
    index('memo_comments_user_idx').on(t.userId),
  ],
)

// 同一用户对同一 memo 只能转发一次；content 为可选的转发附言
export const memoReposts = sqliteTable(
  'memo_reposts',
  {
    memoId: text('memo_id')
      .notNull()
      .references(() => memos.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    content: text('content'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.memoId, t.userId] }),
    index('memo_reposts_memo_idx').on(t.memoId),
    index('memo_reposts_user_created_idx').on(t.userId, t.createdAt),
  ],
)

// ── Passkey（WebAuthn 凭据） ────────────────────────────
export const passkeys = sqliteTable(
  'passkey',
  {
    // WebAuthn credential id（base64url）
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default('Passkey'),
    // 公钥（base64url，SPKI 格式）
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    // JSON 数组：['usb','nfc','ble','internal']
    transports: text('transports'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('passkey_user_idx').on(t.userId)],
)

// ── API keys（只存哈希，明文仅创建时返回一次） ──────────
export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // token 的 SHA-256 hex；数据库与日志中永不保存明文
    keyHash: text('key_hash').notNull(),
    // token 前缀（含 mome_），仅用于界面展示
    keyPrefix: text('key_prefix').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('api_keys_hash_idx').on(t.keyHash),
    index('api_keys_user_idx').on(t.userId),
  ],
)

// ── tags（支持二级：#标签 / #标签/子标签） ────────────────
// parentId 为空串表示根标签；唯一键按 (userId, name, coalesce(parentId,'')) 判重
export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    parentId: text('parent_id').references((): AnySQLiteColumn => tags.id, {
      onDelete: 'cascade',
    }),
    // 唯一判重键：根标签 coalesce 为空串，避免 SQLite 对 NULL 不判重
    parentKey: text('parent_key')
      .notNull()
      .generatedAlwaysAs(sql`coalesce(parent_id, '')`),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('tags_user_name_parent_idx').on(t.userId, t.name, t.parentKey),
    index('tags_user_parent_idx').on(t.userId, t.parentId),
  ],
)

// ── memo_tags 关联表 ────────────────────────────────────
export const memoTags = sqliteTable(
  'memo_tags',
  {
    memoId: text('memo_id')
      .notNull()
      .references(() => memos.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.memoId, t.tagId] }),
    index('memo_tags_tag_idx').on(t.tagId),
  ],
)

// ── relations（供 db.query.* 使用） ──────────────────────
export const memosRelations = relations(memos, ({ many, one }) => ({
  user: one(user, {
    fields: [memos.userId],
    references: [user.id],
  }),
  tags: many(memoTags),
  likes: many(memoLikes),
  favorites: many(memoFavorites),
  comments: many(memoComments),
  reposts: many(memoReposts),
}))

export const tagsRelations = relations(tags, ({ many, one }) => ({
  user: one(user, {
    fields: [tags.userId],
    references: [user.id],
  }),
  parent: one(tags, {
    fields: [tags.parentId],
    references: [tags.id],
  }),
  children: many(tags),
  memos: many(memoTags),
}))

export const memoTagsRelations = relations(memoTags, ({ one }) => ({
  memo: one(memos, {
    fields: [memoTags.memoId],
    references: [memos.id],
  }),
  tag: one(tags, {
    fields: [memoTags.tagId],
    references: [tags.id],
  }),
}))

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(user, {
    fields: [apiKeys.userId],
    references: [user.id],
  }),
}))

// ── 站点设置（管理员页面写入，运行时生效） ──────────────
export const siteSettings = sqliteTable('site_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

// ── 管理员（首位管理员由 AdminToken 领取，之后可互设） ───
export const adminUsers = sqliteTable(
  'admin_users',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('admin_users_created_idx').on(t.createdAt)],
)
