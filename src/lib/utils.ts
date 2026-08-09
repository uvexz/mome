export function cn(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(' ')
}

/** 数量缩写：1234 → 1.2k */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const v = n / 1000
    return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}k`
  }
  const v = n / 1_000_000
  return `${v.toFixed(1).replace(/\.0$/, '')}M`
}
