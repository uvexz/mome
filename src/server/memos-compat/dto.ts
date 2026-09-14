/**
 * Mome 数据模型 → Memos proto JSON 的 DTO 映射。
 *
 * 只做投影与枚举/资源名映射，不引入第二套数据模型：
 * - `memos/{id}` / `users/{id}` / `attachments/{id}` 资源名按上游规则拼接；
 * - 时间统一为 google.protobuf.Timestamp 的 RFC3339 形态；
 * - Mome 的 public/private 与 Memos 的 PUBLIC/PRIVATE 一一对应，PROTECTED
 *   在 Mome 没有对应语义，写入时折叠为 private，读取时不会返回。
 */
import { resolveAvatarUrl } from '#/lib/avatar'
import type { apiKeys, memoComments, memos, user } from '#/db/schema'
import { memoProperty, protoTimestamp, snippet } from './json'

type UserRow = typeof user.$inferSelect
type MemoRow = typeof memos.$inferSelect
type ApiKeyRow = typeof apiKeys.$inferSelect

export const MEMO_PREFIX = 'memos'
export const USER_PREFIX = 'users'
export const ATTACHMENT_PREFIX = 'attachments'

export function memoName(id: string): string {
  return `${MEMO_PREFIX}/${id}`
}

export function userName(id: string): string {
  return `${USER_PREFIX}/${id}`
}

export type MemosVisibility = 'PRIVATE' | 'PROTECTED' | 'PUBLIC'
export type MemosState = 'NORMAL' | 'ARCHIVED'

export function visibilityToJson(value: 'public' | 'private'): MemosVisibility {
  return value === 'public' ? 'PUBLIC' : 'PRIVATE'
}

/** 客户端写入的 visibility → Mome 的两值可见性；未指定返回 undefined */
export function visibilityFromJson(
  value: unknown,
): 'public' | 'private' | undefined {
  switch (value) {
    case undefined:
    case null:
    case '':
    case 'VISIBILITY_UNSPECIFIED':
      return undefined
    case 'PUBLIC':
      return 'public'
    // Mome 没有「登录用户可读」这一档，PROTECTED 折叠为 private
    case 'PROTECTED':
    case 'PRIVATE':
      return 'private'
    default:
      return undefined
  }
}

export function stateToJson(archived: boolean): MemosState {
  return archived ? 'ARCHIVED' : 'NORMAL'
}

export function userJson(
  row: UserRow,
  opts: { isAdmin: boolean; includeEmail: boolean },
): Record<string, unknown> {
  const json: Record<string, unknown> = {
    name: userName(row.id),
    role: opts.isAdmin ? 'ADMIN' : 'USER',
    username: row.username,
    displayName: row.name,
    avatarUrl: resolveAvatarUrl(row.image, row.username),
    state: 'NORMAL',
    createTime: protoTimestamp(row.createdAt),
    updateTime: protoTimestamp(row.updatedAt),
  }
  if (opts.includeEmail && row.email) json.email = row.email
  if (row.bio) json.description = row.bio
  return json
}

export interface ReactionView {
  userId: string
  createdAt: Date
}

export interface RelationView {
  memoId: string
  relatedMemoId: string
  snippet: string
}

export interface MemoJsonInput {
  row: MemoRow
  /** 完整层级标签路径，如 ['工作/项目'] */
  tags: string[]
  reactions?: ReactionView[]
  relations?: RelationView[]
  /** 评论 memo 的父 memo 资源名 */
  parent?: string
}

export function memoJson(input: MemoJsonInput): Record<string, unknown> {
  const { row, tags } = input
  const property = memoProperty(row.content)
  const json: Record<string, unknown> = {
    name: memoName(row.id),
    // 上游 name = `memos/{uid}`：Mome 只有这一个 ID，两者同值（web-clipper 等客户端优先取 uid）
    uid: row.id,
    state: stateToJson(row.archived),
    creator: userName(row.userId),
    createTime: protoTimestamp(row.createdAt),
    updateTime: protoTimestamp(row.updatedAt),
    content: row.content,
    visibility: visibilityToJson(row.visibility),
    pinned: row.pinned,
    tags,
    property: {
      hasLink: property.hasLink,
      hasTaskList: property.hasTaskList,
      hasCode: property.hasCode,
      hasIncompleteTasks: property.hasIncompleteTasks,
      title: property.title,
    },
    snippet: snippet(row.content),
  }
  if (input.parent) json.parent = input.parent
  if (input.reactions && input.reactions.length > 0) {
    json.reactions = input.reactions.map((reaction) =>
      reactionJson(row.id, reaction.userId, reaction.createdAt),
    )
  }
  if (input.relations && input.relations.length > 0) {
    json.relations = input.relations.map((relation) =>
      relationJson(relation.memoId, relation.relatedMemoId, relation.snippet),
    )
  }
  return json
}

/** Mome 的评论不是 memo 行，这里按 Memos 语义投影成带 parent 的 memo */
export function commentJson(
  row: typeof memoComments.$inferSelect,
  opts: { parentId: string; parentVisibility: 'public' | 'private' },
): Record<string, unknown> {
  const pseudo = {
    id: row.id,
    userId: row.userId,
    content: row.content,
    visibility: opts.parentVisibility,
    pinned: false,
    archived: false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as MemoRow
  return memoJson({
    row: pseudo,
    tags: [],
    parent: memoName(opts.parentId),
  })
}

export function reactionJson(
  memoId: string,
  userId: string,
  createdAt: Date,
): Record<string, unknown> {
  return {
    name: `${memoName(memoId)}/reactions/${userId}`,
    creator: userName(userId),
    reactionType: '👍',
    createTime: protoTimestamp(createdAt),
  }
}

export function relationJson(
  memoId: string,
  relatedMemoId: string,
  relatedSnippet: string,
): Record<string, unknown> {
  return {
    memo: { name: memoName(memoId) },
    relatedMemo: { name: memoName(relatedMemoId), snippet: relatedSnippet },
    type: 'REFERENCE',
  }
}

export function personalAccessTokenJson(
  userId: string,
  row: ApiKeyRow,
): Record<string, unknown> {
  const json: Record<string, unknown> = {
    name: `${userName(userId)}/personalAccessTokens/${row.id}`,
    createdAt: protoTimestamp(row.createdAt),
  }
  if (row.name) json.description = row.name
  if (row.expiresAt) json.expiresAt = protoTimestamp(row.expiresAt)
  if (row.lastUsedAt) json.lastUsedAt = protoTimestamp(row.lastUsedAt)
  return json
}
