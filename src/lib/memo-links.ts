const MEMO_LINK_RE = /\[\[memo:([0-9A-HJKMNP-TV-Z]{26})\]\]/giu

export function parseMemoReferences(content: string): string[] {
  const ids = new Set<string>()
  for (const match of content.matchAll(MEMO_LINK_RE)) {
    ids.add(match[1].toUpperCase())
  }
  return [...ids]
}

export function renderMemoReferences(
  content: string,
  username?: string,
): string {
  return content.replace(MEMO_LINK_RE, (_match, id: string) => {
    if (!username) return `[MEMO ${id.toUpperCase()}]`
    return `[MEMO](/@${encodeURIComponent(username)}/${id.toUpperCase()})`
  })
}

export function memoReference(id: string): string {
  return `[[memo:${id}]]`
}
