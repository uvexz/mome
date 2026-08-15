import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Text } from '@cloudflare/kumo'

import { LoginTabs } from '#/components/login-forms'
import { appConfigQueryOptions } from '#/lib/queries'
import { getSessionUser } from '#/server/session'

export const Route = createFileRoute('/login')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(appConfigQueryOptions()),
  beforeLoad: async () => {
    const user = await getSessionUser()
    if (user) throw redirect({ to: '/' })
  },
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const { data: config } = useSuspenseQuery(appConfigQueryOptions())

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2">
          <img
            src={config.siteIcon}
            alt={config.siteName}
            className="h-10 w-10 object-contain"
          />
          <h1 className="text-xl font-semibold text-kumo-strong">
            登录 {config.siteName}
          </h1>
          <Text variant="secondary">记下此刻的想法。</Text>
        </div>

        <LoginTabs onDone={() => void navigate({ to: '/' })} />

        <p className="mt-8 text-center text-sm text-kumo-subtle">
          还没有账号？{' '}
          <a
            href="/signup"
            className="font-medium text-kumo-link hover:underline"
          >
            注册
          </a>
        </p>
      </div>
    </div>
  )
}
