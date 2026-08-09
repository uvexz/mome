import { useEffect, useState } from 'react'
import { startAuthentication } from '@simplewebauthn/browser'
import {
  Button,
  Dialog,
  Field,
  Input,
  SensitiveInput,
  Text,
} from '@cloudflare/kumo'
import {
  ArrowRight,
  EnvelopeSimple,
  Fingerprint,
  Key,
  X,
} from '@phosphor-icons/react'

import { authClient } from '#/lib/auth-client'
import { cn } from '#/lib/utils'
import { getAppConfig } from '#/server/config'
import {
  generatePasskeyLoginOptionsFn,
  verifyPasskeyLoginFn,
} from '#/server/passkeys'

type Tab = 'password' | 'otp' | 'passkey'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'password', label: '密码' },
  { key: 'otp', label: '验证码' },
  { key: 'passkey', label: 'Passkey' },
]

/**
 * 登录表单（密码 / 验证码 / Passkey），登录页与公共主页登录弹窗共用。
 */
export function LoginTabs({ onDone }: { onDone?: () => void }) {
  const [tab, setTab] = useState<Tab>('password')
  const [emailEnabled, setEmailEnabled] = useState(false)

  useEffect(() => {
    void getAppConfig()
      .then((c) => setEmailEnabled(c.emailEnabled))
      .catch(() => setEmailEnabled(false))
  }, [])

  useEffect(() => {
    if (tab === 'otp' && !emailEnabled) setTab('password')
  }, [tab, emailEnabled])

  const tabs = TABS.filter((t) => t.key !== 'otp' || emailEnabled)

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-1 rounded-lg bg-kumo-tint p-0.5 text-sm">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              'flex-1 rounded-md px-3 py-1.5 font-medium',
              tab === t.key
                ? 'bg-kumo-base text-kumo-strong ring ring-kumo-line'
                : 'text-kumo-subtle hover:text-kumo-default',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'password' && <PasswordForm onDone={onDone} />}
      {tab === 'otp' && emailEnabled && <OtpForm onDone={onDone} />}
      {tab === 'passkey' && <PasskeyForm />}
    </div>
  )
}

/** 公共主页登录弹窗 */
export function LoginDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: () => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="w-full max-w-sm p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <Dialog.Title className="text-base font-semibold">
            登录 mome
          </Dialog.Title>
          <Dialog.Close
            aria-label="关闭"
            render={(props) => (
              <Button
                {...props}
                variant="ghost"
                shape="square"
                size="xs"
                icon={<X size={16} />}
                aria-label="关闭"
              />
            )}
          />
        </div>
        <LoginTabs onDone={onDone} />
        <p className="mt-6 text-center text-sm text-kumo-subtle">
          还没有账号？{' '}
          <a
            href="/signup"
            className="font-medium text-kumo-link hover:underline"
          >
            注册
          </a>
        </p>
      </Dialog>
    </Dialog.Root>
  )
}

function PasswordForm({ onDone }: { onDone?: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const res = await authClient.signIn.email({ email, password })
    if (res.error) {
      setError('邮箱或密码不正确')
      setSubmitting(false)
      return
    }
    onDone?.()
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
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
      <Field label="密码">
        <SensitiveInput
          name="password"
          aria-label="密码"
          autoComplete="current-password"
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
        icon={submitting ? undefined : <Key />}
        className="mt-2 w-full justify-center"
      >
        登录
      </Button>
    </form>
  )
}

function OtpForm({ onDone }: { onDone?: () => void }) {
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function sendCode(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const res = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: 'sign-in',
    })
    setSubmitting(false)
    if (res.error) {
      setError(res.error.message ?? '发送失败，请稍后再试')
      return
    }
    setStep('code')
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const res = await authClient.signIn.emailOtp({ email, otp })
    if (res.error) {
      setError(res.error.message ?? '验证码不正确')
      setSubmitting(false)
      return
    }
    onDone?.()
  }

  if (step === 'email') {
    return (
      <form onSubmit={(e) => void sendCode(e)} className="grid gap-4" noValidate>
        <Field label="邮箱" description="验证码将发送到你的邮箱">
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
        {error && (
          <p className="text-sm text-kumo-danger" role="alert">
            {error}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          icon={submitting ? undefined : <EnvelopeSimple />}
          className="mt-2 w-full justify-center"
        >
          发送验证码
        </Button>
      </form>
    )
  }

  return (
    <form onSubmit={(e) => void verify(e)} className="grid gap-4" noValidate>
      <Field label="验证码" description={`已发送至 ${email}`}>
        <Input
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="验证码"
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
        登录
      </Button>
      <button
        type="button"
        onClick={() => setStep('email')}
        className="text-center text-sm text-kumo-subtle hover:text-kumo-default"
      >
        重新发送 / 更换邮箱
      </button>
    </form>
  )
}

function PasskeyForm() {
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handlePasskey() {
    setError(null)
    setSubmitting(true)
    try {
      const options = await generatePasskeyLoginOptionsFn()
      const assertion = await startAuthentication({
        optionsJSON: options.options,
      })
      const res = await verifyPasskeyLoginFn({
        data: { challengeId: options.challengeId, response: assertion },
      })
      await authClient.oneTimeToken.verify({ token: res.token })
      // one-time-token 插件不会自动刷新 session 原子，整页跳转重新加载会话
      window.location.href = '/'
    } catch (err) {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setError('已取消，或设备不支持 Passkey')
      } else {
        setError(
          err instanceof Error && err.message
            ? err.message
            : 'Passkey 登录失败，请重试',
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="grid gap-4">
      <Text variant="secondary">
        使用设备上的指纹、面容或安全密钥免密登录。
      </Text>
      {error && (
        <p className="text-sm text-kumo-danger" role="alert">
          {error}
        </p>
      )}
      <Button
        variant="primary"
        loading={submitting}
        icon={submitting ? undefined : <Fingerprint size={18} />}
        className="mt-2 w-full justify-center"
        onClick={() => void handlePasskey()}
      >
        使用 Passkey 登录
      </Button>
    </div>
  )
}
