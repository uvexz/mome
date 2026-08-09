import { useEffect, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { Moon, Sun } from '@phosphor-icons/react'

type Mode = 'light' | 'dark'

export function ThemeToggle() {
  // 初始为 null：SSR 与首帧客户端渲染保持一致，挂载后再读取实际主题，避免水合 mismatch
  const [mode, setMode] = useState<Mode | null>(null)

  useEffect(() => {
    setMode(
      document.documentElement.getAttribute('data-mode') === 'dark'
        ? 'dark'
        : 'light',
    )
  }, [])

  function toggle() {
    const current = mode ?? 'light'
    const next: Mode = current === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-mode', next)
    try {
      localStorage.setItem('mome-theme', next)
    } catch {}
    setMode(next)
  }

  return (
    <Button
      variant="ghost"
      shape="square"
      icon={mode === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      onClick={toggle}
      aria-label={
        mode === null
          ? '切换主题'
          : mode === 'dark'
            ? '切换到亮色模式'
            : '切换到暗色模式'
      }
      title={
        mode === null
          ? '切换主题'
          : mode === 'dark'
            ? '切换到亮色模式'
            : '切换到暗色模式'
      }
    />
  )
}
