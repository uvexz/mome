import { describe, expect, test } from 'bun:test'

import {
  memoReference,
  parseMemoReferences,
  renderMemoReferences,
} from './memo-links'

const FIRST = '01JZZZZZZZZZZZZZZZZZZZZZZZ'
const SECOND = '01K00000000000000000000000'

describe('memo links', () => {
  test('parses unique references and normalizes case', () => {
    expect(
      parseMemoReferences(
        `before [[memo:${FIRST.toLowerCase()}]] [[memo:${SECOND}]] [[memo:${FIRST}]]`,
      ),
    ).toEqual([FIRST, SECOND])
  })

  test('renders references as internal Markdown links', () => {
    expect(renderMemoReferences(`see ${memoReference(FIRST)}`)).toBe(
      `see [MEMO](/memo/${FIRST})`,
    )
  })
})
