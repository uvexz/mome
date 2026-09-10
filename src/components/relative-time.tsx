import { useEffect, useState } from 'react'

import { relativeTime } from '#/lib/date'

/**
 * 相对时间显示。
 *
 * `relativeTime` 依赖运行环境的本地时区与当前时刻：服务端与浏览器时区不同、
 * 或首屏与 hydration 之间跨过了分钟/日界，SSR 文本与客户端文本会不一致。
 * 这里首屏渲染一个确定性的时间（服务端与客户端首帧一致），hydration 之后
 * 再切换为按浏览器本地时区计算的相对时间。
 */
export function RelativeTime({ iso }: { iso: string }) {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  return (
    <span suppressHydrationWarning>
      {hydrated ? relativeTime(iso) : isoDayLabel(iso)}
    </span>
  )
}

/** 与时区无关的确定性首屏文本：UTC 日期 */
function isoDayLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`
}
