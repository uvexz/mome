/**
 * #标签解析（纯函数，无依赖）
 *
 * 语法：`#标签` / `#标签/子标签`（支持多级嵌套）。
 * 标签字符：字母 / 数字 / 下划线 / 连字符 / CJK；`#` 前需有词边界（空白或行首）。
 */

// 匹配 `#tag` 或 `#a/b`；`#` 前必须是行首或空白/括号（避免匹配 URL 锚点、邮箱等）
const HASHTAG_RE =
  /(?:^|[\s([{【「〈《])#([\p{L}\p{N}_][\p{L}\p{N}_-]*(?:\/[\p{L}\p{N}_][\p{L}\p{N}_-]*)*)/gu

/**
 * 从内容中解析出所有标签路径（去重、保持顺序）。
 * 例如 `今天学了 #rust/ownership 和 #rust` → ['rust/ownership', 'rust']
 */
export function parseHashtags(content: string): string[] {
  const tags: string[] = []
  const re = new RegExp(HASHTAG_RE.source, 'gu')
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    const tag = match[1]
    if (!tags.includes(tag)) {
      tags.push(tag)
    }
  }
  return tags
}

/**
 * 把标签路径拆成层级片段。
 * `'工作/会议'` → `['工作', '会议']`；`'生活'` → `['生活']`
 */
export function tagPathToSegments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/**
 * 是否为合法标签名（单个片段）。
 */
export function isValidTagName(name: string): boolean {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u.test(name)
}
