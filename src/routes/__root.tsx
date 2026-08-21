import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
} from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { Button, LinkButton, Toasty } from '@cloudflare/kumo'

import { authClient } from '#/lib/auth-client'
import type { RouterContext } from '#/lib/query-client'
import { appConfigQueryOptions } from '#/lib/queries'
import { ServiceWorkerRegister } from '#/components/service-worker-register'

import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import appCss from '../styles.css?url'

// 防 FOUC 主题脚本放在 public/theme-init.js（外联文件，满足生产 CSP script-src 'self'）

export const Route = createRootRouteWithContext<RouterContext>()({
  errorComponent: RootErrorComponent,
  notFoundComponent: RootNotFoundComponent,
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(appConfigQueryOptions()),
  head: ({ loaderData }) => {
    const siteName = loaderData?.siteName ?? 'mome'
    const siteDescription =
      loaderData?.siteDescription ?? '极简 memos —— 快速记录碎片想法'
    const siteIcon = loaderData?.siteIcon ?? '/favicon.png'
    return {
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { title: siteName },
        { name: 'description', content: siteDescription },
      ],
      links: [
        { rel: 'icon', type: 'image/png', href: siteIcon },
        { rel: 'manifest', href: '/site.webmanifest' },
        { rel: 'stylesheet', href: appCss },
      ],
      scripts: [{ src: '/theme-init.js' }],
    }
  },
  component: RootComponent,
  shellComponent: RootDocument,
})

function RootComponent() {
  const isLoading = useRouterState({
    select: (state) => state.status === 'pending',
  })

  return (
    <>
      {isLoading && (
        <div className="page-loading-progress" aria-hidden="true" />
      )}
      <QuerySessionBoundary>
        <Outlet />
        {import.meta.env.DEV && <DeveloperTools />}
      </QuerySessionBoundary>
    </>
  )
}

function QuerySessionBoundary({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const { data: session, isPending } = authClient.useSession()
  const initialized = useRef(false)
  const previousUserId = useRef<string | null>(null)

  useEffect(() => {
    if (isPending) return
    const userId = session?.user.id ?? null
    if (initialized.current && previousUserId.current !== userId) {
      queryClient.clear()
    }
    initialized.current = true
    previousUserId.current = userId
  }, [isPending, queryClient, session?.user.id])

  return children
}

function DeveloperTools() {
  const router = useRouter()
  return (
    <TanStackDevtools
      config={{ position: 'bottom-right' }}
      plugins={[
        {
          name: 'Tanstack Router',
          render: <TanStackRouterDevtoolsPanel router={router} />,
        },
      ]}
    />
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <ServiceWorkerRegister />
        <Toasty>{children}</Toasty>
        <Scripts />
      </body>
    </html>
  )
}

function RootErrorComponent({ error, reset }: ErrorComponentProps) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-lg font-semibold text-kumo-strong">出错了</h1>
      <p className="text-sm text-kumo-subtle">
        {error instanceof Error ? error.message : '发生未知错误，请稍后重试。'}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={reset}>
          重试
        </Button>
        <LinkButton href="/" variant="secondary">
          返回首页
        </LinkButton>
      </div>
    </main>
  )
}

function RootNotFoundComponent() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-lg font-semibold text-kumo-strong">页面不存在</h1>
      <p className="text-sm text-kumo-subtle">这个页面可能已被移动或删除。</p>
      <Link
        to="/"
        className="rounded-lg bg-kumo-base px-3 py-1.5 text-sm font-medium text-kumo-default ring ring-kumo-line hover:bg-kumo-tint"
      >
        返回首页
      </Link>
    </main>
  )
}
