import { useEffect, useState } from 'react'
import { Button, Checkbox, Dialog, Input, Select } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'

import type { HomeSearch } from '#/lib/search'

export function SearchFiltersDialog({
  open,
  onOpenChange,
  value,
  onApply,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: HomeSearch
  onApply: (patch: Partial<HomeSearch>) => void
}) {
  const [visibility, setVisibility] = useState<'all' | 'public' | 'private'>(
    value.visibility ?? 'all',
  )
  const [favorited, setFavorited] = useState(value.favorited ?? false)
  const [from, setFrom] = useState(value.from ?? '')
  const [to, setTo] = useState(value.to ?? '')

  useEffect(() => {
    if (!open) return
    setVisibility(value.visibility ?? 'all')
    setFavorited(value.favorited ?? false)
    setFrom(value.from ?? '')
    setTo(value.to ?? '')
  }, [open, value.favorited, value.from, value.to, value.visibility])

  function apply() {
    onApply({
      visibility: visibility === 'all' ? undefined : visibility,
      favorited: favorited || undefined,
      from: from || undefined,
      to: to || undefined,
    })
    onOpenChange(false)
  }

  function clear() {
    setVisibility('all')
    setFavorited(false)
    setFrom('')
    setTo('')
    onApply({
      visibility: undefined,
      favorited: undefined,
      from: undefined,
      to: undefined,
    })
    onOpenChange(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="px-5 py-4">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <Dialog.Title className="text-base font-semibold">
              筛选 memo
            </Dialog.Title>
            <Dialog.Description className="text-sm text-kumo-subtle">
              筛选仅应用于自己的 memo。
            </Dialog.Description>
          </div>
          <Dialog.Close
            aria-label="关闭"
            render={(props) => (
              <Button
                {...props}
                variant="ghost"
                shape="square"
                icon={<X size={16} />}
                aria-label="关闭"
              />
            )}
          />
        </div>

        <div className="grid gap-5">
          <Select
            label="可见性"
            value={visibility}
            onValueChange={(next) => setVisibility(next ?? 'all')}
            items={{ all: '全部', private: '仅自己可见', public: '公开' }}
          />
          <Checkbox
            label="只看收藏"
            checked={favorited}
            onCheckedChange={setFavorited}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              type="date"
              label="开始日期"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
            <Input
              type="date"
              label="结束日期"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
        </div>

        <div className="mt-6 flex justify-between gap-2">
          <Button variant="ghost" onClick={clear}>
            清除
          </Button>
          <Button variant="primary" onClick={apply}>
            应用
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
