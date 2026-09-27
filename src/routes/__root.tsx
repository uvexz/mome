import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
} from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { Button, LinkButton, Toasty } from '@cloudflare/kumo'

import { authClient } from '#/lib/auth-client'
import type { RouterContext } from '#/lib/query-client'
import { appConfigQueryOptions } from '#/lib/queries'
import { SessionUsernameProvider } from '#/lib/session-context'
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
  const [, setIdentityRevision] = useState(0)
  const userId = session?.user.id ?? null
  const identityChanged =
    initialized.current && previousUserId.current !== userId

  useEffect(() => {
    if (isPending) return
    if (identityChanged) {
      // 只清掉已无观察者且不在请求中的查询。queryClient.clear() 会销毁所有
      // 查询并取消进行中的请求，注销/登录后的导航 loader（ensureQueryData）
      // 会被连带取消，路由收到 CancelledError 进入错误页。
      queryClient.removeQueries({
        predicate: (query) =>
          query.getObserversCount() === 0 && query.state.fetchStatus === 'idle',
      })
      // 仍被观察的查询不能直接移除，但也不能留着上一账号的数据：查询 key 里
      // 没有身份，新账号会命中同一条缓存并在 staleTime 内直接读到旧数据。
      // reset 后重新拉取，且不会取消无观察者的 loader 请求。
      queryClient.resetQueries({
        predicate: (query) => query.getObserversCount() > 0,
      })
      // 剩下的（切换瞬间无观察者但仍在请求中的）查询，其响应可能在切换之后
      // 才落缓存：全部标记为过期，避免下次挂载时在 staleTime 内直接读到旧数据。
      queryClient.invalidateQueries({ refetchType: 'none' })
    }
    initialized.current = true
    previousUserId.current = userId
    if (identityChanged) setIdentityRevision((revision) => revision + 1)
  }, [identityChanged, isPending, queryClient, userId])

  if (identityChanged) return null

  return (
    <SessionUsernameProvider username={session?.user.username ?? null}>
      {children}
    </SessionUsernameProvider>
  )
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
