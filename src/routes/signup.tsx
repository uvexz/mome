import {
  createFileRoute,
  redirect,
  useLoaderData,
  useNavigate,
} from '@tanstack/react-router'
import { useState } from 'react'
import { Button, Field, Input, SensitiveInput, Text } from '@cloudflare/kumo'
import { ArrowRight } from '@phosphor-icons/react'

import { authClient } from '#/lib/auth-client'
import {
  isValidUsername,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '#/lib/username'
import { getAppConfig } from '#/server/config'
import { getSessionUser } from '#/server/session'

export const Route = createFileRoute('/signup')({
  loader: async () => getAppConfig(),
  beforeLoad: async () => {
    const user = await getSessionUser()
    if (user) throw redirect({ to: '/' })
  },
  component: SignupPage,
})

function SignupPage() {
  const navigate = useNavigate()
  const features = useLoaderData({ from: '/signup' })
  const [step, setStep] = useState<'form' | 'verify'>('form')
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError('密码至少 8 位')
      return
    }
    if (!isValidUsername(username)) {
      setError(
        `用户名需为 ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} 位小写字母/数字/下划线/连字符`,
      )
      return
    }
    setSubmitting(true)
    const res = await authClient.signUp.email({
      name,
      username: username.toLowerCase(),
      email,
      password,
    })
    if (res.error) {
      setError(res.error.message ?? '注册失败，请稍后再试')
      setSubmitting(false)
      return
    }
    if (!features.emailEnabled || res.data.user.emailVerified) {
      await navigate({ to: '/' })
      return
    }
    setStep('verify')
    setSubmitting(false)
  }

  async function verifyEmail(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const res = await authClient.emailOtp.verifyEmail({ email, otp })
    if (res.error) {
      setError(res.error.message ?? '验证码不正确')
      setSubmitting(false)
      return
    }
    await navigate({ to: '/' })
  }

  async function resendCode() {
    setError(null)
    const res = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: 'email-verification',
    })
    if (res.error) {
      setError(res.error.message ?? '发送失败，请稍后再试')
    }
  }

  if (!features.allowSignup) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center gap-2">
            <img
              src={features.siteIcon}
              alt={features.siteName}
              className="h-10 w-10 object-contain"
            />
            <h1 className="text-xl font-semibold text-kumo-strong">
              注册已关闭
            </h1>
            <Text variant="secondary">
              {features.siteName} 暂时不开放新账号注册。
            </Text>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="h-8 w-full justify-center"
            onClick={() => void navigate({ to: '/login' })}
          >
            返回登录
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2">
          <img
            src={features.siteIcon}
            alt={features.siteName}
            className="h-10 w-10 object-contain"
          />
          <h1 className="text-xl font-semibold text-kumo-strong">创建账号</h1>
          <Text variant="secondary">30 秒开启你的碎片记录。</Text>
        </div>

        {step === 'verify' ? (
          <form
            onSubmit={(e) => void verifyEmail(e)}
            className="grid gap-4"
            noValidate
          >
            <Text variant="secondary">
              验证码已发送至{' '}
              <span className="font-medium text-kumo-default">{email}</span>
              ，请输入后完成注册。
            </Text>
            <Field label="邮箱验证码">
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="邮箱验证码"
                placeholder="6 位数字"
                value={otp}
                onChange={(e) =>
                  setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                required
              />
            </Field>
            {error && (
              <p className="text-sm text-kumo-danger" role="alert">
                {error}
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              loading={submitting}
              icon={submitting ? undefined : <ArrowRight />}
              className="mt-2 w-full justify-center"
            >
              验证邮箱
            </Button>
            <button
              type="button"
              onClick={() => void resendCode()}
              className="text-center text-sm text-kumo-subtle hover:text-kumo-default"
            >
              重新发送验证码
            </button>
          </form>
        ) : (
          <form onSubmit={onSubmit} className="grid gap-4" noValidate>
            <Field label="昵称">
              <Input
                name="name"
                aria-label="昵称"
                autoComplete="name"
                placeholder="你的名字"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </Field>
            <Field
              label="用户名"
              description={`公开主页 /@${username || 'username'}，注册后不可更改`}
            >
              <div className="relative w-full">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center font-mono text-sm text-kumo-subtle">
                  @
                </span>
                <Input
                  name="username"
                  aria-label="用户名"
                  autoComplete="username"
                  placeholder="username"
                  value={username}
                  onChange={(e) =>
                    setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))
                  }
                  className="w-full pl-7"
                  required
                />
              </div>
            </Field>
            <Field label="邮箱">
              <Input
                type="email"
                name="email"
                aria-label="邮箱"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>
            <Field label="密码" description="至少 8 位">
              <SensitiveInput
                name="password"
                aria-label="密码"
                autoComplete="new-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>

            {error && (
              <p className="text-sm text-kumo-danger" role="alert">
                {error}
              </p>
            )}

            <Button
              type="submit"
              variant="primary"
              loading={submitting}
              icon={submitting ? undefined : <ArrowRight />}
              className="mt-2 w-full justify-center"
            >
              注册
            </Button>
          </form>
        )}

        <p className="mt-8 text-center text-sm text-kumo-subtle">
          已有账号？{' '}
          <a
            href="/login"
            className="font-medium text-kumo-link hover:underline"
          >
            登录
          </a>
        </p>
      </div>
    </div>
  )
}
