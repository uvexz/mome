import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button, InputGroup } from '@cloudflare/kumo'
import { GlobeSimple, MagnifyingGlass, Sparkle, X } from '@phosphor-icons/react'

import { getAppConfig } from '#/server/config'

import type { HomeSearch } from '#/lib/search'
import { ThemeToggle } from './theme-toggle'
import { UserMenu } from './user-menu'

interface SiteHeaderProps {
  search: HomeSearch
  onSearchChange: (q: string | undefined) => void
}

const SEARCH_DEBOUNCE_MS = 300

/**
 * 顶栏：logo / 搜索入口 / 主题切换 / 用户菜单。
 * sticky + border-b 与内容分隔。
 */
export function SiteHeader({ search, onSearchChange }: SiteHeaderProps) {
  const navigate = useNavigate()
  const [q, setQ] = useState(search.q ?? '')
  const [site, setSite] = useState({ name: 'mome', icon: '/favicon.png' })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 外部导航（如点标签）改变 q 时同步输入框
  useEffect(() => {
    setQ(search.q ?? '')
  }, [search.q])

  useEffect(() => {
    void getAppConfig()
      .then((config) =>
        setSite({ name: config.siteName, icon: config.siteIcon }),
      )
      .catch(() => {})
  }, [])

  function handleChange(value: string) {
    setQ(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      onSearchChange(value.trim() || undefined)
    }, SEARCH_DEBOUNCE_MS)
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return (
    <header className="sticky top-0 z-40 border-b border-kumo-line bg-kumo-canvas/85 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-[640px] items-center gap-3 px-4">
        <a
          href="/"
          className="flex shrink-0 items-center gap-2 text-sm font-semibold text-kumo-strong"
        >
          <img
            src={site.icon}
            alt={site.name}
            className="h-6 w-6 object-contain"
          />
          {site.name}
        </a>

        <div className="min-w-0 flex-1">
          <InputGroup size="sm" className="h-8">
            <InputGroup.Addon align="start">
              <MagnifyingGlass size={14} className="text-kumo-subtle" />
            </InputGroup.Addon>
            <InputGroup.Input
              placeholder="搜索 memo…"
              value={q}
              onChange={(e) => handleChange(e.target.value)}
              aria-label="搜索 memo"
              className="h-8"
            />
            {q && (
              <InputGroup.Addon align="end">
                <InputGroup.Button
                  variant="ghost"
                  shape="square"
                  icon={<X size={13} />}
                  onClick={() => handleChange('')}
                  aria-label="清除搜索"
                />
              </InputGroup.Addon>
            )}
          </InputGroup>
        </div>

        <Button
          variant="ghost"
          shape="square"
          icon={<GlobeSimple size={16} />}
          aria-label="公共主页"
          title="公共主页"
          onClick={() => void navigate({ to: '/explore' })}
        />

        <Button
          variant="ghost"
          shape="square"
          icon={<Sparkle size={16} />}
          aria-label="每日回顾"
          title="每日回顾"
          onClick={() => void navigate({ to: '/review' })}
        />

        <ThemeToggle />

        <UserMenu />
      </div>
    </header>
  )
}
