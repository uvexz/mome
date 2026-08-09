import { isValidTagName } from './hashtags'

export interface WebClipInput {
  title: string
  url: string
  description: string
  content: string
  tags: string[]
}

export function normalizeClipTag(value: string): string | null {
  const tag = value.trim().replace(/^#+/, '')
  if (!tag) return null
  const segments = tag.split('/')
  return segments.every(isValidTagName) ? segments.join('/') : null
}

export function buildWebClipContent(input: WebClipInput): string {
  const title = input.title.trim()
  const description = input.description.trim()
  const content = input.content.trim()
  const tags = Array.from(
    new Set(input.tags.map(normalizeClipTag).filter((tag) => tag !== null)),
  )
  const source = new URL(input.url)
  const parts: string[] = []

  if (title) parts.push(`## ${title}`)
  if (description && description !== content) {
    parts.push(
      description
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
    )
  }
  if (content) parts.push(content)
  parts.push(`来源：[${source.hostname}](${source.href})`)
  if (tags.length > 0) parts.push(tags.map((tag) => `#${tag}`).join(' '))

  return parts.join('\n\n')
}
