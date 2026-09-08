/**
 * Memos 兼容层的 proto-JSON 基础工具：
 * google.protobuf.Timestamp 的 RFC3339 形态、不透明分页游标、
 * FieldMask 查询参数、资源名与 snippet/property 派生字段。
 */
import { Code, MemosError } from './errors'

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
 * 分页游标：Mome 用不透明的 base64url JSON 承载 offset。
 * Memos 官方游标是 protobuf PageToken{limit, offset}，客户端只当作不透明字符串回传。
 */
export function encodePageToken(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url')
}

export function decodePageToken(token: string | null): number {
  if (!token) return 0
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(token, 'base64url').toString(),
    )
    if (parsed && typeof parsed === 'object' && 'o' in parsed) {
      const offset = parsed.o
      if (
        typeof offset === 'number' &&
        Number.isInteger(offset) &&
        offset >= 0
      ) {
        return offset
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
