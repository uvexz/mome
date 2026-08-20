import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  memo,
  useContext,
} from 'react'
import type { ReactElement, ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { renderMemoReferences } from '#/lib/memo-links'

/** 标签点击回调（未提供时默认跳到首页按标签筛选） */
const HashtagClickContext = createContext<((tag: string) => void) | null>(null)

// 与 lib/hashtags.ts 保持一致的匹配规则
const HASHTAG_RE =
  /(?:^|[\s([{【「〈《])#([\p{L}\p{N}_][\p{L}\p{N}_-]*(?:\/[\p{L}\p{N}_][\p{L}\p{N}_-]*)*)/gu

/**
 * 把 memo 内容渲染为 Markdown；文本中的 #标签 保持为可点击高亮。
 * 链接 / 代码内部不转换，避免嵌套交互元素或破坏代码语义。
 */
export const HashtagText = memo(function HashtagText({
  content,
  onTagClick,
  memoUsername,
}: {
  content: string
  onTagClick?: (tag: string) => void
  memoUsername?: string
}) {
  // pre-wrap 只放在叶子容器（p/li/标题/单元格），
  // 避免块元素之间的换行文本节点被渲染成空行
  return (
    <HashtagClickContext.Provider value={onTagClick ?? null}>
      <div className="min-w-0 max-w-full break-words">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={markdownComponents}
        >
          {renderMemoReferences(content, memoUsername)}
        </ReactMarkdown>
      </div>
    </HashtagClickContext.Provider>
  )
})

const markdownComponents: Components = {
  p: ({ children }) => (
    <p className="m-0 whitespace-pre-wrap">{transformInline(children)}</p>
  ),
  h1: ({ children }) => (
    <h1 className="my-1.5 whitespace-pre-wrap text-sm font-semibold text-kumo-strong">
      {transformInline(children)}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="my-1.5 whitespace-pre-wrap text-sm font-semibold text-kumo-strong">
      {transformInline(children)}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="my-1.5 whitespace-pre-wrap text-sm font-semibold text-kumo-strong">
      {transformInline(children)}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="my-1.5 whitespace-pre-wrap text-sm font-semibold text-kumo-strong">
      {transformInline(children)}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="my-1.5 whitespace-pre-wrap text-sm font-semibold text-kumo-strong">
      {transformInline(children)}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="my-1.5 whitespace-pre-wrap text-sm font-semibold text-kumo-strong">
      {transformInline(children)}
    </h6>
  ),
  strong: ({ children }) => (
    <strong className="font-medium">{transformInline(children)}</strong>
  ),
  em: ({ children }) => <em>{transformInline(children)}</em>,
  del: ({ children }) => (
    <del className="text-kumo-subtle">{transformInline(children)}</del>
  ),
  a: ({ href, children }) => {
    const internal = href?.startsWith('/@')
    return (
      <a
        href={href}
        target={internal ? undefined : '_blank'}
        rel={internal ? undefined : 'noreferrer'}
        className="font-medium text-kumo-link hover:underline"
      >
        {children}
      </a>
    )
  },
  code: ({ children }) => (
    <code className="rounded bg-kumo-tint px-1 font-mono text-[0.9em] text-kumo-default">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-kumo-tint p-3 font-mono text-[0.9em] text-kumo-default [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  ul: ({ children }) => <ul className="my-1.5 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => (
    <ol className="my-1.5 list-decimal pl-5">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="my-0.5 whitespace-pre-wrap">{transformInline(children)}</li>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-kumo-line pl-3 text-kumo-subtle">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-0 border-t border-kumo-line" />,
  img: ({ src, alt }) => (
    <img
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      className="my-2 block h-auto max-w-full rounded-lg"
    />
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="whitespace-pre-wrap border border-kumo-line px-2 py-1 text-left font-semibold text-kumo-strong">
      {transformInline(children)}
    </th>
  ),
  td: ({ children }) => (
    <td className="whitespace-pre-wrap border border-kumo-line px-2 py-1">
      {transformInline(children)}
    </td>
  ),
}

/** 递归遍历内联节点，把文本叶子中的 #标签 替换为可点击按钮 */
function transformInline(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === 'string' || typeof child === 'number') {
      return <InlineHashtags text={String(child)} />
    }
    if (isValidElement(child)) {
      const type = child.type as string
      // 链接/代码内保持纯文本，避免嵌套按钮或破坏代码内容
      if (type === 'a' || type === 'code' || type === 'pre') return child
      const props = child.props as { children?: ReactNode }
      return cloneElement(child as ReactElement<{ children?: ReactNode }>, {
        children: transformInline(props.children),
      })
    }
    return child
  })
}

function InlineHashtags({ text }: { text: string }) {
  const navigate = useNavigate()
  const onTagClick = useContext(HashtagClickContext)
  const nodes: ReactNode[] = []
  const re = new RegExp(HASHTAG_RE.source, 'gu')
  let last = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(<span key={key++}>{text.slice(last, match.index)}</span>)
    }
    const tag = match[1]
    // 只保留 # 前的边界字符（空白/括号等），# 由按钮输出一次，避免双 # 号
    const prefixEnd = match.index + match[0].length - tag.length - 1
    if (match.index < prefixEnd) {
      nodes.push(<span key={key++}>{text.slice(match.index, prefixEnd)}</span>)
    }
    nodes.push(
      <button
        key={key++}
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          if (onTagClick) {
            onTagClick(tag)
            return
          }
          void navigate({ to: '/', search: { tag } })
        }}
        className="rounded font-medium text-accent hover:bg-accent/10"
      >
        #{tag}
      </button>,
    )
    last = match.index + match[0].length
  }

  if (last < text.length) {
    nodes.push(<span key={key++}>{text.slice(last)}</span>)
  }

  return <>{nodes}</>
}
