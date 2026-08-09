import { describe, expect, it } from 'vitest'

import {
  isValidTagName,
  parseHashtags,
  segmentsToTagPath,
  tagPathToSegments,
} from '../src/lib/hashtags'

describe('parseHashtags', () => {
  it('解析单个标签', () => {
    expect(parseHashtags('今天学了 #rust')).toEqual(['rust'])
  })

  it('解析中文标签', () => {
    expect(parseHashtags('工作上的 #灵感 记录')).toEqual(['灵感'])
  })

  it('解析二级标签 #标签/子标签', () => {
    expect(parseHashtags('读了 #书籍/代码大全')).toEqual(['书籍/代码大全'])
  })

  it('解析多个标签并去重', () => {
    expect(
      parseHashtags('#生活 #工作 #生活 周末'), //
    ).toEqual(['生活', '工作'])
  })

  it('支持数字、下划线、连字符', () => {
    expect(parseHashtags('#v2 #my_tag #foo-bar')).toEqual([
      'v2',
      'my_tag',
      'foo-bar',
    ])
  })

  it('行首标签可解析', () => {
    expect(parseHashtags('#开头 的内容')).toEqual(['开头'])
  })

  it('不解析 # 后跟空白的用例', () => {
    expect(parseHashtags('一个 # 符号')).toEqual([])
  })

  it('不解析单词中间的 #（如 URL 锚点）', () => {
    expect(parseHashtags('https://example.com/page#anchor')).toEqual([])
  })

  it('标签后紧跟中文标点也能正确截断', () => {
    expect(parseHashtags('#工作，明天继续')).toEqual(['工作'])
    expect(parseHashtags('#读书？是的')).toEqual(['读书'])
  })

  it('标签后紧跟英文标点也能正确截断', () => {
    expect(parseHashtags('#todo. done')).toEqual(['todo'])
    expect(parseHashtags('#todo, done')).toEqual(['todo'])
  })

  it('多级（超两级）也支持', () => {
    expect(parseHashtags('#a/b/c')).toEqual(['a/b/c'])
  })

  it('空内容返回空数组', () => {
    expect(parseHashtags('')).toEqual([])
    expect(parseHashtags('   ')).toEqual([])
  })
})

describe('tagPathToSegments / segmentsToTagPath', () => {
  it('拆分与组合往返', () => {
    expect(tagPathToSegments('工作/会议')).toEqual(['工作', '会议'])
    expect(segmentsToTagPath(['工作', '会议'])).toBe('工作/会议')
    expect(tagPathToSegments('生活')).toEqual(['生活'])
  })
})

describe('isValidTagName', () => {
  it('合法名称', () => {
    expect(isValidTagName('rust')).toBe(true)
    expect(isValidTagName('工作')).toBe(true)
    expect(isValidTagName('my_tag')).toBe(true)
  })
  it('非法名称', () => {
    expect(isValidTagName('')).toBe(false)
    expect(isValidTagName('a b')).toBe(false)
    expect(isValidTagName('a/b')).toBe(false)
  })
})
