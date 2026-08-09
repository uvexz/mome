import { useMemo, useState } from 'react'
import {
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
} from '@phosphor-icons/react'

import { cn } from '#/lib/utils'
import type { ContributionMonthData } from '#/server/memos'

interface ContributionGraphProps {
  data: ContributionMonthData | null
  loading?: boolean
  /** 移动端：默认收起为一条小栏，点击展开 */
  collapsible?: boolean
  onMonthChange: (month: string) => void
}

interface MonthCell {
  date: string
  count: number
}

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

const CELL_BG: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'bg-kumo-tint text-kumo-inactive',
  1: 'bg-heat-1 text-kumo-strong',
  2: 'bg-heat-2 text-kumo-strong',
  3: 'bg-heat-3 text-kumo-canvas',
  4: 'bg-heat-4 text-kumo-canvas',
}

const LEGEND_BG: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'bg-kumo-tint',
  1: 'bg-heat-1',
  2: 'bg-heat-2',
  3: 'bg-heat-3',
  4: 'bg-heat-4',
}

function countLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0
  if (count <= 2) return 1
  if (count <= 5) return 2
  if (count <= 9) return 3
  return 4
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 组装某月的日历格子：周一开头，月外日期为 null */
function buildCells(data: ContributionMonthData): Array<MonthCell | null> {
  const [year, month] = data.month.split('-').map(Number)
  const countByDate = new Map(data.days.map((d) => [d.date, d.count]))
  const first = new Date(year, month - 1, 1)
  const leadingBlanks = (first.getDay() + 6) % 7 // 周一 = 0
  const dayCount = new Date(year, month, 0).getDate()

  const cells: Array<MonthCell | null> = Array.from(
    { length: leadingBlanks },
    () => null,
  )
  for (let d = 1; d <= dayCount; d++) {
    const date = `${data.month}-${String(d).padStart(2, '0')}`
    cells.push({ date, count: countByDate.get(date) ?? 0 })
  }
  return cells
}

/**
 * 贡献图：按月展示每天 memo 热度的低调绿块日历。
 * 无背景、无边框；移动端默认收起，点击展开。
 * 月份范围以最老一条 memo 所在月份为起点，当前月份为终点。
 */
export function ContributionGraph({
  data,
  loading = false,
  collapsible = false,
  onMonthChange,
}: ContributionGraphProps) {
  const cells = useMemo(() => (data ? buildCells(data) : []), [data])
  const [open, setOpen] = useState(!collapsible)

  if (!data) return null

  const [year, month] = data.month.split('-').map(Number)
  const prevDisabled = loading || data.month <= data.minMonth
  const nextDisabled = loading || data.month >= data.maxMonth
  const monthLabel = `${year}年${month}月`

  const monthSwitcher = (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => onMonthChange(shiftMonth(data.month, -1))}
        disabled={prevDisabled}
        aria-label="上个月"
        title="上个月"
        className="rounded p-0.5 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default disabled:pointer-events-none disabled:opacity-40"
      >
        <CaretLeft size={12} />
      </button>
      <span className="min-w-[72px] text-center font-mono text-[11px] text-kumo-default">
        {monthLabel}
      </span>
      <button
        type="button"
        onClick={() => onMonthChange(shiftMonth(data.month, 1))}
        disabled={nextDisabled}
        aria-label="下个月"
        title="下个月"
        className="rounded p-0.5 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default disabled:pointer-events-none disabled:opacity-40"
      >
        <CaretRight size={12} />
      </button>
    </div>
  )

  // 移动端收起态：一条无背景的小栏，点击展开
  if (collapsible && !open) {
    return (
      <section aria-label="贡献图" className="p-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          className="flex w-full items-center justify-between gap-2"
        >
          <span className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-kumo-strong">贡献</span>
            <span className="font-mono text-[11px] text-kumo-subtle">
              {monthLabel}
            </span>
          </span>
          <CaretDown size={12} className="text-kumo-subtle" />
        </button>
      </section>
    )
  }

  return (
    <section aria-label="贡献图" className="min-w-0 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-kumo-strong">贡献</h2>
        <div className="flex items-center gap-1">
          {monthSwitcher}
          {collapsible && (
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-expanded={true}
              aria-label="收起贡献图"
              title="收起贡献图"
              className="rounded p-0.5 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
            >
              <CaretUp size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {WEEKDAY_LABELS.map((label) => (
          <span
            key={label}
            className="pb-0.5 text-center font-mono text-[9px] text-kumo-subtle"
          >
            {label}
          </span>
        ))}
        {cells.map((cell, i) =>
          cell ? (
            <span
              key={cell.date}
              title={`${cell.date} · ${cell.count} 条`}
              className={cn(
                'flex h-4 w-4 items-center justify-center rounded-[3px] font-mono text-[9px]',
                CELL_BG[countLevel(cell.count)],
              )}
            >
              {Number(cell.date.slice(-2))}
            </span>
          ) : (
            <span key={`blank-${i}`} aria-hidden="true" className="h-4 w-4" />
          ),
        )}
      </div>

      <div className="mt-2 flex items-center justify-end gap-1 text-[9px] text-kumo-subtle">
        <span className="mr-0.5 font-mono">少</span>
        {([0, 1, 2, 3, 4] as const).map((level) => (
          <span
            key={level}
            className={cn('h-[8px] w-[8px] rounded-[2px]', LEGEND_BG[level])}
          />
        ))}
        <span className="ml-0.5 font-mono">多</span>
      </div>
    </section>
  )
}
