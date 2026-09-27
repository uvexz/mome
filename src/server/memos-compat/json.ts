/**
 * Memos 兼容层的 proto-JSON 基础工具：
 * google.protobuf.Timestamp 的 RFC3339 形态、不透明分页游标、
 * FieldMask 查询参数、资源名与 snippet/property 派生字段。
 */
import { Code, MemosError } from './errors'

/**
 * google.protobuf.Timestamp 的 protojson 形态：RFC3339、UTC、`Z` 结尾，
 * **不带小数秒**。
 *
 * 「不带小数秒」不是风格选择，而是硬兼容要求。swift-openapi-runtime 的
 * `Configuration.dateTranscoder` 默认是 `.iso8601`，也就是
 * `ISO8601DateTranscoder()`——它构造的 `ISO8601DateFormatter` 沿用 Foundation
 * 默认的 `.withInternetDateTime`（**不含** `.withFractionalSeconds`）。
 * `Date.prototype.toISOString()` 产出的 `2026-08-08T12:39:43.541Z` 在这个
 * formatter 下 `date(from:)` 返回 nil，transcoder 随即抛
 * `DecodingError.dataCorrupted`（NSCocoaErrorDomain「数据格式不正确」），
 * 于是**整个响应**解码失败——客户端只报
 * `Client encountered an error invoking the operation "…"`。
 *
 * `InstanceProfile.admin.createTime` 是最先撞上的一个：它在版本探测阶段，
 * 也就是登录之前，所以表现为"登录报错"。
 *
 * 上游 Go 服务用 protojson 输出，秒的小数位为 0 时会被裁掉，所以这类客户端
 * 只在 Mome 上炸。Memos 自身的时间戳就是秒精度，这里与上游对齐按秒截断。
 *
 * 所有对外的时间戳都必须走这个函数；直接用 `toISOString()` 会重新引入该缺陷。
 */
export function protoTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`
}

/** 解析客户端提交的 RFC3339 时间戳；非法输入按 INVALID_ARGUMENT 处理 */
export function parseTimestamp(
  value: unknown,
  field: string,
): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') {
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      `${field} 必须是 RFC3339 字符串`,
    )
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      `${field} 不是合法的 RFC3339 时间`,
    )
  }
  return date
}

/**
 * 分页游标：Mome 用不透明的 base64url JSON 承载分页位置。
 * Memos 官方游标是 protobuf PageToken{limit, offset}，客户端只当作不透明字符串回传。
 *
 * 默认排序（create_time desc, id desc）下使用 keyset：token 带上最后一条的
 * 排序值与稳定 ID，深页不再随已跳过的记录数变慢，中途插入新记录也不会让
 * 下一页边界漂移。其他 orderBy 仍退回 offset。
 * 旧版本发出的 `{o}` token 继续可用。
 */
export interface PageCursor {
  offset: number
  keyset?: { createdAt: number; id: string }
}

const MAX_PAGE_TOKEN_LENGTH = 4096
const MAX_PAGE_OFFSET = 100_000

export function encodePageToken(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url')
}

export function encodeKeysetPageToken(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: 2, t: createdAt.getTime(), i: id }),
  ).toString('base64url')
}

export function decodePageToken(token: string | null): PageCursor {
  if (!token) return { offset: 0 }
  if (token.length > MAX_PAGE_TOKEN_LENGTH) {
    throw new MemosError(Code.INVALID_ARGUMENT, 'pageToken 不合法')
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(token, 'base64url').toString(),
    )
    if (parsed && typeof parsed === 'object') {
      if ('t' in parsed && 'i' in parsed) {
        const { t, i } = parsed
        if (
          typeof t === 'number' &&
          Number.isFinite(t) &&
          typeof i === 'string'
        ) {
          return { offset: 0, keyset: { createdAt: t, id: i } }
        }
      }
      if ('o' in parsed) {
        const offset = parsed.o
        if (
          typeof offset === 'number' &&
          Number.isInteger(offset) &&
          offset >= 0 &&
          offset <= MAX_PAGE_OFFSET
        ) {
          return { offset }
        }
      }
    }
  } catch {
    // 落到下面的统一错误
  }
  throw new MemosError(Code.INVALID_ARGUMENT, 'pageToken 不合法')
}

export function clampPageSize(
  raw: string | null,
  fallback = 50,
  max = 1000,
): number {
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) return fallback
  return Math.min(value, max)
}

/** updateMask 查询参数：逗号分隔的字段名（proto 字段名或 camelCase 均可） */
export function parseFieldMask(raw: string | null): Set<string> | null {
  if (raw === null) return null
  const fields = raw
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean)
  return new Set(fields)
}

/** 资源名 `memos/{id}` → `{id}`；前缀不符或 id 为空按 INVALID_ARGUMENT 处理 */
export function resourceId(name: unknown, prefix: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      `资源名不能为空（期望 ${prefix}…）`,
    )
  }
  if (!name.startsWith(`${prefix}/`)) {
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      `资源名格式应为 ${prefix}/{id}，收到 ${name}`,
    )
  }
  const id = name.slice(prefix.length + 1)
  if (id.length === 0 || id.includes('/')) {
    throw new MemosError(Code.INVALID_ARGUMENT, `资源名格式应为 ${prefix}/{id}`)
  }
  return id
}

/** Memo.content 的纯文本摘要（proto 里 snippet 是 output only） */
export function snippet(content: string, max = 120): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max)}…` : plain
}

export interface MemoProperty {
  hasLink: boolean
  hasTaskList: boolean
  hasCode: boolean
  hasIncompleteTasks: boolean
  title: string
}

/** Memo.property：与官方 Web 一致由内容派生，不落库 */
export function memoProperty(content: string): MemoProperty {
  const titleMatch = /^#\s+(.+)$/m.exec(content)
  return {
    hasLink: /(https?:\/\/[^\s)]+)|\[[^\]]*\]\([^)]*\)/.test(content),
    hasTaskList: /^\s*[-*]\s+\[[ xX]\]/m.test(content),
    hasCode: /```/.test(content) || /`[^`\n]+`/.test(content),
    hasIncompleteTasks: /^\s*[-*]\s+\[ \]/m.test(content),
    title: titleMatch ? titleMatch[1].trim() : '',
  }
}
