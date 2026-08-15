// 日期/时间格式化（客户端本地时区）

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** 分组标签：今天 / 昨天 / 3 月 5 日 / 2024 年 3 月 5 日 */
export function dayLabel(d: Date, now: Date = new Date()): string {
  if (isSameDay(d, now)) return '今天'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (isSameDay(d, yesterday)) return '昨天'
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
  }
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/** 相对时间：刚刚 / x 分钟前 / x 小时前 / 昨天 / 日期 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const diff = now.getTime() - d.getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24 && isSameDay(d, now)) return `${hours} 小时前`
  if (isSameDay(d, new Date(now.getTime() - 86_400_000))) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
