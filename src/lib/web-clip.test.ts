import { describe, expect, test } from 'bun:test'

import { buildWebClipContent, normalizeClipTag } from './web-clip'

describe('web clip formatting', () => {
  test('normalizes valid nested tags and rejects invalid tags', () => {
    expect(normalizeClipTag('##阅读/稍后')).toBe('阅读/稍后')
    expect(normalizeClipTag('not valid')).toBeNull()
  })

  test('builds stable Markdown and removes duplicate tags', () => {
    expect(
      buildWebClipContent({
        title: 'Example article',
        url: 'https://example.com/post',
        description: 'A short summary.',
        content: 'Selected paragraph.',
        tags: ['reading', '#reading', 'inbox/web'],
      }),
    ).toBe(
      [
        '## Example article',
        '> A short summary.',
        'Selected paragraph.',
        '来源：[example.com](https://example.com/post)',
        '#reading #inbox/web',
      ].join('\n\n'),
    )
  })
})
