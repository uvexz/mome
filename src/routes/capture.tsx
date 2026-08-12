import {
  createFileRoute,
  redirect,
  useNavigate,
  useSearch,
} from '@tanstack/react-router'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowLeft, NotePencil } from '@phosphor-icons/react'
import { z } from 'zod'

import { Composer } from '#/components/composer'
import { getSessionUser } from '#/server/session'

const captureSearchSchema = z.object({
  title: z.string().max(500).optional(),
  text: z.string().max(5000).optional(),
  url: z.string().max(2000).optional(),
  reference: z.string().max(100).optional(),
  tag: z.literal('收藏').optional(),
})

export const Route = createFileRoute('/capture')({
  validateSearch: captureSearchSchema,
  beforeLoad: async () => {
    const user = await getSessionUser()
    if (!user) throw redirect({ to: '/login' })
  },
  component: CapturePage,
})

function CapturePage() {
  const search = useSearch({ from: '/capture' })
  const navigate = useNavigate()
  const toast = useKumoToastManager()
  const initialContent = buildSharedContent(search)

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-kumo-line bg-kumo-canvas/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[640px] items-center gap-3 px-4">
          <Button
            variant="ghost"
            shape="square"
            icon={<ArrowLeft size={16} />}
            aria-label="返回"
            title="返回"
            onClick={() => void navigate({ to: '/' })}
          />
          <div className="flex items-center gap-2 text-sm font-semibold text-kumo-strong">
            <NotePencil size={16} weight="duotone" className="text-accent" />
            快速记录
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[640px] px-4 pb-24 pt-8">
        <Composer
          draftScope="capture"
          initialContent={initialContent}
          onCreated={() => {
            toast.add({ title: '已记录', variant: 'success' })
            void navigate({ to: '/' })
          }}
          onQueued={() => {
            toast.add({
              title: '已离线保存，联网后自动发送',
              variant: 'success',
            })
          }}
          onError={(message) => toast.add({ title: message, variant: 'error' })}
        />
      </main>
    </div>
  )
}

function buildSharedContent(
  search: z.infer<typeof captureSearchSchema>,
): string {
  const text = search.text?.trim() ?? ''
  const title = search.title?.trim() ?? ''
  const url = search.url?.trim() ?? ''
  const parts: string[] = []
  if (search.reference) parts.push(`[[memo:${search.reference}]]`)
  if (text) parts.push(text)
  if (url && !text.includes(url)) {
    parts.push(title ? `[${title}](${url})` : url)
  } else if (title && !text.includes(title)) {
    parts.unshift(title)
  }
  if (search.tag) parts.push(`#${search.tag}`)
  return parts.join('\n\n')
}
