import {
  createFileRoute,
  redirect,
  useNavigate,
  useSearch,
} from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import {
  Badge,
  Banner,
  Button,
  Dialog,
  Empty,
  Field,
  Grid,
  GridItem,
  Input,
  InputArea,
  LayerCard,
  Loader,
  Select,
  SensitiveInput,
  Sidebar,
  Switch,
  Table,
  Text,
  useKumoToastManager,
  useSidebar,
} from '@cloudflare/kumo'
import {
  CloudArrowUp,
  EnvelopeSimple,
  Gauge,
  GearSix,
  House,
  NotePencil,
  PlugsConnected,
  ShieldCheck,
  Trash,
  UploadSimple,
  UserPlus,
  Users,
  X,
} from '@phosphor-icons/react'
import { z } from 'zod'

import { Avatar } from '#/components/avatar'
import { uploadPresignedPost } from '#/lib/upload'
import { compactNumber } from '#/lib/utils'
import {
  adminGateQueryOptions,
  adminOverviewQueryOptions,
  queryKeys,
} from '#/lib/queries'
import {
  claimAdmin,
  deleteUser,
  saveSiteSettings,
  setUserAdmin,
} from '#/server/admin'
import type { AdminGate, AdminOverview, AdminUserItem } from '#/server/admin'
import { getSessionUser } from '#/server/session'
import { getUploadUrl } from '#/server/upload'

const adminSearchSchema = z.object({
  tab: z
    .enum(['overview', 'general', 'integrations', 'users'])
    .catch('overview')
    .optional(),
})

type AdminTab = 'overview' | 'general' | 'integrations' | 'users'
type NavIcon = React.ComponentType<{ className?: string }>

const ADMIN_NAV: Array<{ value: AdminTab; label: string; icon: NavIcon }> = [
  { value: 'overview', label: '总览', icon: Gauge },
  { value: 'general', label: '站点设置', icon: GearSix },
  { value: 'integrations', label: '服务集成', icon: PlugsConnected },
  { value: 'users', label: '用户管理', icon: Users },
]

export const Route = createFileRoute('/admin')({
  validateSearch: adminSearchSchema,
  beforeLoad: async () => {
    const user = await getSessionUser()
    if (!user) throw redirect({ to: '/login' })
  },
  loader: async ({ context }) => {
    const gate = await context.queryClient.ensureQueryData(
      adminGateQueryOptions(),
    )
    if (gate.isAdmin) {
      await context.queryClient.ensureQueryData(adminOverviewQueryOptions())
    }
  },
  component: AdminPage,
})

function AdminPage() {
  const { data: gate } = useSuspenseQuery(adminGateQueryOptions())

  if (!gate.isAdmin && gate.hasAdmin) return <AccessDenied />
  if (!gate.isAdmin) return <ClaimAdminPage gate={gate} />
  return <AdminDashboard />
}

// ── 非管理员访问 ────────────────────────────────────────
function AccessDenied() {
  const navigate = useNavigate()
  const toast = useKumoToastManager()

  useEffect(() => {
    toast.add({ title: '需要管理员权限', variant: 'error' })
    const timer = setTimeout(() => void navigate({ to: '/' }), 1600)
    return () => clearTimeout(timer)
  }, [navigate, toast])

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col items-center justify-center gap-4 px-4 text-center">
      <span className="h-lh flex items-center text-kumo-subtle">
        <ShieldCheck size={32} />
      </span>
      <h1 className="text-lg font-semibold text-kumo-strong">需要管理员权限</h1>
      <Text variant="secondary" size="sm">
        只有管理员可以访问此页面，即将返回首页…
      </Text>
    </main>
  )
}

// ── 首位管理员初始化 ────────────────────────────────────
function ClaimAdminPage({ gate }: { gate: AdminGate }) {
  const toast = useKumoToastManager()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!token.trim() || busy) return
    setBusy(true)
    try {
      await claimAdmin({ data: { token: token.trim() } })
      toast.add({ title: '已成为管理员', variant: 'success' })
      window.location.href = '/admin'
    } catch (err) {
      toast.add({
        title: '初始化失败',
        description: err instanceof Error ? err.message : '请检查 AdminToken',
        variant: 'error',
      })
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 grid justify-items-center gap-2 text-center">
          <span className="h-lh flex items-center text-accent">
            <ShieldCheck size={32} />
          </span>
          <h1 className="text-xl font-semibold text-kumo-strong">
            初始化管理员
          </h1>
          <Text variant="secondary">
            站点还没有管理员。输入 ADMIN_TOKEN 后，当前账号将成为首位管理员。
          </Text>
        </div>

        {!gate.adminTokenConfigured ? (
          <LayerCard className="px-5 py-4 text-sm text-kumo-subtle">
            尚未配置 <code className="font-mono text-[0.9em]">ADMIN_TOKEN</code>{' '}
            环境变量，请先在部署环境中设置后重试。
          </LayerCard>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="grid gap-4">
            <Field
              label="AdminToken"
              description="首次领取后该令牌不再可用于新增管理员"
            >
              <SensitiveInput
                aria-label="AdminToken"
                autoComplete="off"
                placeholder="输入 ADMIN_TOKEN"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="h-8 font-mono text-sm"
                required
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              icon={busy ? undefined : <ShieldCheck size={14} />}
              className="mt-2 w-full justify-center"
            >
              成为管理员
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}

// ── 管理后台 ────────────────────────────────────────────
type Draft = {
  siteName: string
  siteDescription: string
  siteIcon: string
  allowSignup: boolean
  defaultVisibility: 'public' | 'private'
  s3: {
    endpoint: string
    region: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    publicUrl: string
    forcePathStyle: boolean
  }
  smtp: {
    host: string
    port: number
    secure: boolean
    user: string
    password: string
    from: string
  }
  resend: {
    apiKey: string
    from: string
  }
}

function AdminDashboard() {
  const { data: overview } = useSuspenseQuery(adminOverviewQueryOptions())
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return <AdminLoading />

  return (
    <Sidebar.Provider collapsible="icon" defaultOpen className="h-dvh">
      <AdminShell overview={overview} />
    </Sidebar.Provider>
  )
}

function AdminLoading() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Loader />
    </div>
  )
}

function AdminShell({ overview }: { overview: AdminOverview }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const search = useSearch({ from: '/admin' })
  const toast = useKumoToastManager()
  const { setOpenMobile } = useSidebar()
  const [draft, setDraft] = useState<Draft>(() => toDraft(overview.settings))
  const [users, setUsers] = useState<AdminUserItem[]>(overview.users)
  const [s3Enabled, setS3Enabled] = useState(overview.settings.s3.enabled)
  const [smtpConfigured, setSmtpConfigured] = useState(
    overview.settings.smtp.configured,
  )
  const [resendConfigured, setResendConfigured] = useState(
    overview.settings.resend.configured,
  )
  const [saving, setSaving] = useState(false)
  const activeTab: AdminTab = search.tab ?? 'overview'

  async function refresh() {
    const next = await queryClient.fetchQuery({
      ...adminOverviewQueryOptions(),
      staleTime: 0,
    })
    await queryClient.invalidateQueries({
      queryKey: queryKeys.public,
      refetchType: 'none',
    })
    setUsers(next.users)
    setS3Enabled(next.settings.s3.enabled)
    setSmtpConfigured(next.settings.smtp.configured)
    setResendConfigured(next.settings.resend.configured)
    setDraft(toDraft(next.settings))
  }

  async function save() {
    setSaving(true)
    try {
      await saveSiteSettings({ data: toSaveInput(draft) })
      await queryClient.invalidateQueries({ queryKey: queryKeys.config })
      await refresh()
      toast.add({ title: '设置已保存', variant: 'success' })
    } catch (err) {
      toast.add({
        title: '保存失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  function go(tab: AdminTab) {
    void navigate({
      to: '/admin',
      search: { tab },
      replace: true,
    })
  }

  function goAndClose(tab: AdminTab) {
    setOpenMobile(false)
    go(tab)
  }

  return (
    <>
      <Sidebar>
        <Sidebar.Header>
          <a href="/" className="flex min-w-0 flex-1 items-center gap-2 px-1.5">
            <img
              src={overview.settings.siteIcon}
              alt=""
              className="h-6 w-6 shrink-0 object-contain"
            />
            <span className="truncate text-sm font-semibold text-kumo-strong">
              {overview.settings.siteName}
            </span>
          </a>
          <Sidebar.Close className="md:hidden" />
        </Sidebar.Header>
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.GroupLabel>管理</Sidebar.GroupLabel>
            <Sidebar.Menu>
              {ADMIN_NAV.map((item) => (
                <Sidebar.MenuButton
                  key={item.value}
                  icon={item.icon}
                  tooltip={item.label}
                  active={activeTab === item.value}
                  onClick={() => goAndClose(item.value)}
                >
                  {item.label}
                </Sidebar.MenuButton>
              ))}
            </Sidebar.Menu>
          </Sidebar.Group>
          <Sidebar.Separator />
          <Sidebar.Group>
            <Sidebar.GroupLabel>返回</Sidebar.GroupLabel>
            <Sidebar.Menu>
              <Sidebar.MenuButton
                icon={House}
                tooltip="返回站点"
                onClick={() => {
                  setOpenMobile(false)
                  void navigate({ to: '/' })
                }}
              >
                返回站点
              </Sidebar.MenuButton>
            </Sidebar.Menu>
          </Sidebar.Group>
        </Sidebar.Content>
        <Sidebar.Footer>
          <Sidebar.Trigger className="hidden md:flex" />
        </Sidebar.Footer>
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]">
        <main className="mx-auto w-full max-w-[960px] px-4 pb-16 pt-8 lg:px-8">
          <div className="mb-6 flex items-center md:hidden">
            <Sidebar.Trigger aria-label="打开导航" />
          </div>
          {activeTab === 'overview' && (
            <OverviewSection overview={overview} onNavigate={go} />
          )}
          {activeTab === 'general' && (
            <GeneralSection
              draft={draft}
              s3Enabled={s3Enabled}
              saving={saving}
              onDraftChange={setDraft}
              onSave={() => void save()}
            />
          )}
          {activeTab === 'integrations' && (
            <IntegrationsSection
              draft={draft}
              s3Enabled={s3Enabled}
              smtpConfigured={smtpConfigured}
              resendConfigured={resendConfigured}
              saving={saving}
              onDraftChange={setDraft}
              onSave={() => void save()}
            />
          )}
          {activeTab === 'users' && (
            <UsersSection users={users} onRefresh={refresh} />
          )}
        </main>
      </div>
    </>
  )
}

function toDraft(settings: AdminOverview['settings']): Draft {
  return {
    siteName: settings.siteName,
    siteDescription: settings.siteDescription,
    siteIcon: settings.siteIcon,
    allowSignup: settings.allowSignup,
    defaultVisibility: settings.defaultVisibility,
    s3: {
      endpoint: settings.s3.endpoint,
      region: settings.s3.region,
      bucket: settings.s3.bucket,
      accessKeyId: '',
      secretAccessKey: '',
      publicUrl: settings.s3.publicUrl,
      forcePathStyle: settings.s3.forcePathStyle,
    },
    smtp: {
      host: settings.smtp.host,
      port: settings.smtp.port,
      secure: settings.smtp.secure,
      user: settings.smtp.user,
      password: '',
      from: settings.smtp.from,
    },
    resend: {
      apiKey: '',
      from: settings.resend.from,
    },
  }
}

function toSaveInput(draft: Draft) {
  return {
    siteName: draft.siteName,
    siteDescription: draft.siteDescription,
    siteIcon: draft.siteIcon,
    allowSignup: draft.allowSignup,
    defaultVisibility: draft.defaultVisibility,
    s3: { ...draft.s3 },
    smtp: { ...draft.smtp },
    resend: { ...draft.resend },
  }
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <LayerCard className="grid gap-6 px-5 py-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <Text as="h2" variant="heading3">
            {title}
          </Text>
          {description && (
            <Text variant="secondary" size="sm">
              {description}
            </Text>
          )}
        </div>
        {action}
      </div>
      {children}
    </LayerCard>
  )
}

// ── 总览 ────────────────────────────────────────────────
function OverviewSection({
  overview,
  onNavigate,
}: {
  overview: AdminOverview
  onNavigate: (tab: AdminTab) => void
}) {
  const settings = overview.settings
  const totalMemos = overview.users.reduce(
    (sum, user) => sum + user.memoCount,
    0,
  )
  const adminCount = overview.users.filter((user) => user.isAdmin).length
  const emailConfigured = settings.smtp.configured || settings.resend.configured

  return (
    <div className="grid gap-8">
      <div className="grid gap-1.5">
        <Text as="h2" variant="heading3">
          总览
        </Text>
        <Text variant="secondary" size="sm">
          站点运行状态与关键指标。
        </Text>
      </div>

      {!emailConfigured && (
        <Banner
          variant="alert"
          icon={<EnvelopeSimple size={16} />}
          title="邮件服务未配置"
          description="注册验证码、登录 OTP 与换邮箱验证码将无法发送。"
          action={
            <Banner.Action
              variant="secondary"
              onClick={() => onNavigate('integrations')}
            >
              去配置
            </Banner.Action>
          }
        />
      )}

      <Grid variant="1-2-4up" gap="sm">
        <StatCard
          icon={<Users size={20} />}
          label="用户"
          value={String(overview.users.length)}
        />
        <StatCard
          icon={<NotePencil size={20} />}
          label="memo 总数"
          value={compactNumber(totalMemos)}
        />
        <StatCard
          icon={<ShieldCheck size={20} />}
          label="管理员"
          value={String(adminCount)}
        />
        <StatCard
          icon={<UserPlus size={20} />}
          label="开放注册"
          value={settings.allowSignup ? '开启' : '关闭'}
        />
      </Grid>

      <Section title="服务状态" description="对象存储与邮件服务的当前配置。">
        <div className="grid gap-3">
          <ServiceStatusRow
            icon={<CloudArrowUp size={16} />}
            name="S3 对象存储"
            detail={
              settings.s3.enabled
                ? `${settings.s3.endpoint} / ${settings.s3.bucket}`
                : '未配置 Endpoint 或密钥'
            }
            status={settings.s3.enabled ? '已启用' : '未配置'}
            variant={settings.s3.enabled ? 'success' : 'warning'}
          />
          <ServiceStatusRow
            icon={<EnvelopeSimple size={16} />}
            name="SMTP 邮件"
            detail={
              settings.smtp.configured
                ? `${settings.smtp.host}:${settings.smtp.port}`
                : '未配置 Host 或密码'
            }
            status={settings.smtp.configured ? '已配置' : '未配置'}
            variant={settings.smtp.configured ? 'success' : 'neutral'}
          />
          <ServiceStatusRow
            icon={<EnvelopeSimple size={16} />}
            name="Resend 邮件"
            detail={
              settings.resend.configured
                ? `发件人 ${settings.resend.from}`
                : '未配置 API Key'
            }
            status={settings.resend.configured ? '已配置' : '未配置'}
            variant={settings.resend.configured ? 'success' : 'neutral'}
          />
        </div>
      </Section>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <LayerCard className="grid gap-2 px-5 py-4 text-sm">
      <span className="h-lh flex items-center text-kumo-subtle">{icon}</span>
      <div className="grid gap-1.5">
        <Text variant="secondary" size="sm">
          {label}
        </Text>
        <Text
          as="p"
          DANGEROUS_className="text-xl font-semibold text-kumo-strong"
        >
          {value}
        </Text>
      </div>
    </LayerCard>
  )
}

function ServiceStatusRow({
  icon,
  name,
  detail,
  status,
  variant,
}: {
  icon: React.ReactNode
  name: string
  detail: string
  status: string
  variant: 'success' | 'warning' | 'neutral'
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg bg-kumo-tint px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="h-lh flex shrink-0 items-center text-kumo-subtle">
          {icon}
        </span>
        <div className="min-w-0">
          <Text
            as="p"
            DANGEROUS_className="truncate text-sm font-medium text-kumo-strong"
          >
            {name}
          </Text>
          <Text variant="secondary" size="sm" truncate>
            {detail}
          </Text>
        </div>
      </div>
      <Badge variant={variant} appearance="dot" className="text-sm">
        {status}
      </Badge>
    </div>
  )
}

// ── 站点信息 ────────────────────────────────────────────
function GeneralSection({
  draft,
  s3Enabled,
  saving,
  onDraftChange,
  onSave,
}: {
  draft: Draft
  s3Enabled: boolean
  saving: boolean
  onDraftChange: (next: Draft) => void
  onSave: () => void
}) {
  const toast = useKumoToastManager()
  const fileRef = useRef<HTMLInputElement>(null)
  const [iconUrl, setIconUrl] = useState('')

  async function pickFile(file: File | undefined) {
    if (!file) return
    try {
      const dataUrl = await resizeImage(file)
      // resizeImage 统一重编码为 PNG，扩展名必须与真实字节一致，
      // 否则 S3 策略的 Content-Type 断言（image/png）会拒绝上传
      const upload = await getUploadUrl({
        data: { kind: 'site-icon', ext: 'png' },
      })
      if (upload.mode === 'presigned') {
        const blob = await (await fetch(dataUrl)).blob()
        await uploadPresignedPost(upload, blob)
        onDraftChange({ ...draft, siteIcon: upload.publicUrl })
      }
      toast.add({ title: '图标已更新，记得保存', variant: 'success' })
    } catch {
      toast.add({ title: '图片处理失败', variant: 'error' })
    }
  }

  return (
    <Section title="站点设置" description="名称、简介与图标会立即应用到全站。">
      <div className="flex items-center gap-4">
        <img
          src={draft.siteIcon}
          alt="站点图标"
          className="h-12 w-12 rounded-lg object-contain ring ring-kumo-line"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void pickFile(e.target.files?.[0])}
            aria-label="上传站点图标"
          />
          <Button
            variant="secondary"
            size="sm"
            icon={<UploadSimple size={14} />}
            disabled={!s3Enabled}
            onClick={() => fileRef.current?.click()}
            className="h-8"
          >
            上传图标
          </Button>
          {!s3Enabled && (
            <Text variant="secondary" size="sm" DANGEROUS_className="max-w-48">
              配置 S3 后可上传，当前可用图片 URL。
            </Text>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Input
          type="url"
          placeholder="或粘贴图标 URL"
          aria-label="站点图标 URL"
          value={iconUrl}
          onChange={(e) => setIconUrl(e.target.value)}
          className="h-8 flex-1 text-sm"
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!iconUrl.trim()}
          onClick={() => {
            const url = iconUrl.trim()
            if (!url) return
            // 站点图标经 <link rel="icon"> 被全站访客浏览器加载，
            // 仅允许 https 或本地路径，防止 http 明文与追踪滥用
            if (!/^https:\/\//i.test(url) && !url.startsWith('/')) {
              toast.add({
                title: '图标 URL 必须以 https:// 开头',
                variant: 'error',
              })
              return
            }
            onDraftChange({ ...draft, siteIcon: url })
            setIconUrl('')
          }}
          className="h-8"
        >
          使用
        </Button>
      </div>

      <div className="grid gap-4">
        <Field label="站点名称">
          <Input
            aria-label="站点名称"
            value={draft.siteName}
            onChange={(e) =>
              onDraftChange({ ...draft, siteName: e.target.value })
            }
            className="h-8 text-sm"
          />
        </Field>
        <Field label="站点简介">
          <InputArea
            aria-label="站点简介"
            placeholder="介绍这个站点…"
            value={draft.siteDescription}
            onChange={(e) =>
              onDraftChange({
                ...draft,
                siteDescription: e.target.value,
              })
            }
            className="min-h-20 w-full resize-y px-4 py-2 text-sm"
            maxLength={500}
          />
        </Field>
        <Grid variant="2up" gap="sm">
          <GridItem>
            <Field label="开放注册">
              <div className="pt-1">
                <Switch
                  label={draft.allowSignup ? '允许新用户注册' : '已关闭注册'}
                  checked={draft.allowSignup}
                  onCheckedChange={(checked) =>
                    onDraftChange({ ...draft, allowSignup: checked })
                  }
                />
              </div>
            </Field>
          </GridItem>
          <GridItem>
            <Field label="新 memo 默认可见性">
              <Select
                aria-label="默认可见性"
                className="h-8"
                value={draft.defaultVisibility}
                onValueChange={(value) =>
                  onDraftChange({
                    ...draft,
                    defaultVisibility: value as 'public' | 'private',
                  })
                }
                items={{
                  private: '仅自己可见',
                  public: '公开',
                }}
              />
            </Field>
          </GridItem>
        </Grid>
      </div>

      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          loading={saving}
          onClick={onSave}
          className="h-8"
        >
          保存站点设置
        </Button>
      </div>
    </Section>
  )
}

function resizeImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const size = 256
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('canvas unsupported')
        const scale = Math.max(size / img.width, size / img.height)
        const w = size / scale
        const h = size / scale
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
        URL.revokeObjectURL(url)
        resolve(canvas.toDataURL('image/png'))
      } catch (err) {
        URL.revokeObjectURL(url)
        reject(err)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('invalid image'))
    }
    img.src = url
  })
}

// ── S3 / SMTP / Resend ─────────────────────────────────
function IntegrationsSection({
  draft,
  s3Enabled,
  smtpConfigured,
  resendConfigured,
  saving,
  onDraftChange,
  onSave,
}: {
  draft: Draft
  s3Enabled: boolean
  smtpConfigured: boolean
  resendConfigured: boolean
  saving: boolean
  onDraftChange: (next: Draft) => void
  onSave: () => void
}) {
  return (
    <div className="grid gap-8">
      <S3Section
        draft={draft}
        enabled={s3Enabled}
        onDraftChange={onDraftChange}
      />
      <SmtpSection
        draft={draft}
        configured={smtpConfigured}
        onDraftChange={onDraftChange}
      />
      <ResendSection
        draft={draft}
        configured={resendConfigured}
        onDraftChange={onDraftChange}
      />
      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          loading={saving}
          onClick={onSave}
          className="h-8"
        >
          保存服务设置
        </Button>
      </div>
    </div>
  )
}

function S3Section({
  draft,
  enabled,
  onDraftChange,
}: {
  draft: Draft
  enabled: boolean
  onDraftChange: (next: Draft) => void
}) {
  const s3 = draft.s3
  return (
    <Section
      title="S3 对象存储"
      description="用于头像、memo 图片与站点图标上传；密钥留空表示保留当前配置。"
      action={
        <Badge
          variant={enabled ? 'success' : 'warning'}
          appearance="dot"
          className="text-sm"
        >
          {enabled ? '已启用' : '未配置'}
        </Badge>
      }
    >
      <Grid variant="2up" gap="sm">
        <GridItem>
          <Field label="Endpoint">
            <Input
              aria-label="S3 Endpoint"
              placeholder="https://s3.example.com"
              value={s3.endpoint}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  s3: { ...s3, endpoint: e.target.value },
                })
              }
              className="h-8 font-mono text-sm"
            />
          </Field>
        </GridItem>
        <GridItem>
          <Field label="Region">
            <Input
              aria-label="S3 Region"
              value={s3.region}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  s3: { ...s3, region: e.target.value },
                })
              }
              className="h-8 font-mono text-sm"
            />
          </Field>
        </GridItem>
        <GridItem>
          <Field label="Bucket">
            <Input
              aria-label="S3 Bucket"
              value={s3.bucket}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  s3: { ...s3, bucket: e.target.value },
                })
              }
              className="h-8 font-mono text-sm"
            />
          </Field>
        </GridItem>
        <GridItem>
          <Field label="Access Key ID" description="留空保留当前配置">
            <Input
              aria-label="S3 Access Key ID"
              value={s3.accessKeyId}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  s3: { ...s3, accessKeyId: e.target.value },
                })
              }
              className="h-8 font-mono text-sm"
            />
          </Field>
        </GridItem>
        <GridItem>
          <Field label="Secret Access Key" description="留空保留当前密钥">
            <SensitiveInput
              aria-label="S3 Secret Access Key"
              value={s3.secretAccessKey}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  s3: { ...s3, secretAccessKey: e.target.value },
                })
              }
              className="h-8 font-mono text-sm"
            />
          </Field>
        </GridItem>
        <GridItem>
          <Field label="公开访问地址" description="可选，默认 Endpoint/Bucket">
            <Input
              aria-label="S3 Public URL"
              value={s3.publicUrl}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  s3: { ...s3, publicUrl: e.target.value },
                })
              }
              className="h-8 font-mono text-sm"
            />
          </Field>
        </GridItem>
      </Grid>
      <div className="pt-1">
        <Switch
          label="Force Path Style"
          checked={s3.forcePathStyle}
          onCheckedChange={(checked) =>
            onDraftChange({
              ...draft,
              s3: { ...s3, forcePathStyle: checked },
            })
          }
        />
      </div>
    </Section>
  )
}

function SmtpSection({
  draft,
  configured,
  onDraftChange,
}: {
  draft: Draft
  configured: boolean
  onDraftChange: (next: Draft) => void
}) {
  const smtp = draft.smtp
  return (
    <Section
      title="SMTP 邮件"
      description="配置后用于发送注册验证码、登录 OTP 与换邮箱验证码。"
      action={
        <Badge
          variant={configured ? 'success' : 'neutral'}
          appearance="dot"
          className="text-sm"
        >
          {configured ? '已配置' : '未配置'}
        </Badge>
      }
    >
      <Grid variant="2up" gap="sm">
        <GridItem>
          <Field label="Host">
            <Input
              aria-label="SMTP Host"
              placeholder="smtp.example.com"
              value={smtp.host}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  smtp: { ...smtp, host: e.target.value },
                })
              }
              className="h-8 font-mono text-sm"
            />
          </Field>
        </GridItem>
        <GridItem>
          <Field label="Port">
            <Input
              type="number"
              aria-label="SMTP Port"
              value={smtp.port}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  smtp: {
                    ...smtp,
                    port: Number(e.target.value) || 587,
                  },
                })
              }
              className="h-8 font-mono text-sm"
            />
          </Field>
        </GridItem>
        <GridItem>
          <Field label="User">
            <Input
              aria-label="SMTP User"
              value={smtp.user}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  smtp: { ...smtp, user: e.target.value },
                })
              }
              className="h-8 font-mono text-sm"
            />
          </Field>
        </GridItem>
        <GridItem>
          <Field label="Password" description="留空保留当前密码">
            <SensitiveInput
              aria-label="SMTP Password"
              value={smtp.password}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  smtp: { ...smtp, password: e.target.value },
                })
              }
              className="h-8 font-mono text-sm"
            />
          </Field>
        </GridItem>
        <GridItem>
          <Field label="发件人" description="例如 mome <noreply@example.com>">
            <Input
              aria-label="SMTP From"
              value={smtp.from}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  smtp: { ...smtp, from: e.target.value },
                })
              }
              className="h-8 text-sm"
            />
          </Field>
        </GridItem>
      </Grid>
      <div className="pt-1">
        <Switch
          label="使用 SSL/TLS（端口 465 时通常开启）"
          checked={smtp.secure}
          onCheckedChange={(checked) =>
            onDraftChange({
              ...draft,
              smtp: { ...smtp, secure: checked },
            })
          }
        />
      </div>
    </Section>
  )
}

function ResendSection({
  draft,
  configured,
  onDraftChange,
}: {
  draft: Draft
  configured: boolean
  onDraftChange: (next: Draft) => void
}) {
  const resend = draft.resend
  return (
    <Section
      title="Resend 邮件"
      description="未配置 SMTP 时使用 Resend；API Key 留空表示保留当前密钥。"
      action={
        <Badge
          variant={configured ? 'success' : 'neutral'}
          appearance="dot"
          className="text-sm"
        >
          {configured ? '已配置' : '未配置'}
        </Badge>
      }
    >
      <Grid variant="2up" gap="sm">
        <GridItem>
          <Field label="API Key" description="留空保留当前密钥">
            <SensitiveInput
              aria-label="Resend API Key"
              value={resend.apiKey}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  resend: { ...resend, apiKey: e.target.value },
                })
              }
              className="h-8 font-mono text-sm"
            />
          </Field>
        </GridItem>
        <GridItem>
          <Field label="发件人" description="例如 mome <noreply@example.com>">
            <Input
              aria-label="Resend From"
              value={resend.from}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  resend: { ...resend, from: e.target.value },
                })
              }
              className="h-8 text-sm"
            />
          </Field>
        </GridItem>
      </Grid>
    </Section>
  )
}

// ── 用户管理 ───────────────────────────────────────────
function UsersSection({
  users,
  onRefresh,
}: {
  users: AdminUserItem[]
  onRefresh: () => Promise<void>
}) {
  const toast = useKumoToastManager()
  const [deleting, setDeleting] = useState<AdminUserItem | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSetAdmin(item: AdminUserItem, admin: boolean) {
    try {
      await setUserAdmin({ data: { userId: item.id, admin } })
      await onRefresh()
      toast.add({
        title: admin ? '已设为管理员' : '已取消管理员',
        variant: 'success',
      })
    } catch (err) {
      toast.add({
        title: '操作失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    }
  }

  async function handleDelete() {
    if (!deleting || busy) return
    setBusy(true)
    try {
      await deleteUser({ data: { userId: deleting.id } })
      setDeleting(null)
      await onRefresh()
      toast.add({ title: '用户已删除', variant: 'success' })
    } catch (err) {
      toast.add({
        title: '删除失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="用户管理"
      description="可查看账号信息、任命/取消管理员，或删除用户（关联数据级联清理）。"
    >
      {users.length === 0 ? (
        <Empty
          size="sm"
          icon={<Users size={40} />}
          title="还没有用户"
          description="用户注册后会自动出现在这里。"
        />
      ) : (
        <div className="overflow-x-auto">
          <Table className="min-w-[760px] [&_td]:text-sm [&_th]:text-sm">
            <Table.Header>
              <Table.Row>
                <Table.Head>用户</Table.Head>
                <Table.Head>加入时间</Table.Head>
                <Table.Head>memo</Table.Head>
                <Table.Head>邮箱</Table.Head>
                <Table.Head className="text-right">操作</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {users.map((item) => (
                <Table.Row key={item.id}>
                  <Table.Cell>
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar
                        username={item.username}
                        image={item.image}
                        size={32}
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-kumo-strong">
                            {item.name}
                          </span>
                          {item.isAdmin && (
                            <Badge variant="primary" className="text-sm">
                              管理员
                            </Badge>
                          )}
                        </div>
                        <span className="block truncate font-mono text-sm text-kumo-subtle">
                          @{item.username}
                        </span>
                      </div>
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <span className="text-sm text-kumo-default">
                      {new Date(item.createdAt).toLocaleDateString('zh-CN')}
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    <span className="text-sm text-kumo-default">
                      {item.memoCount}
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 truncate font-mono text-sm text-kumo-subtle">
                        {item.email}
                      </span>
                      <Badge
                        variant={item.emailVerified ? 'success' : 'warning'}
                        appearance="dot"
                        className="text-sm"
                      >
                        {item.emailVerified ? '已验证' : '未验证'}
                      </Badge>
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-8"
                        onClick={() => void handleSetAdmin(item, !item.isAdmin)}
                      >
                        {item.isAdmin ? '取消管理员' : '设为管理员'}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        icon={<Trash size={14} />}
                        className="h-8"
                        onClick={() => setDeleting(item)}
                      >
                        删除
                      </Button>
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}

      <Dialog.Root
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <Dialog className="p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <Dialog.Title className="text-base font-semibold">
              删除用户
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
          <Dialog.Description className="text-sm text-kumo-subtle">
            确定删除用户
            {deleting ? (
              <>
                {' '}
                <span className="font-medium text-kumo-default">
                  {deleting.name}
                </span>{' '}
                (@{deleting.username})
              </>
            ) : null}
            ？该用户的所有 memo、评论、点赞等数据将被永久删除，无法恢复。
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button variant="secondary" {...props}>
                  取消
                </Button>
              )}
            />
            <Button
              variant="destructive"
              loading={busy}
              icon={<Trash size={14} />}
              onClick={() => void handleDelete()}
            >
              确认删除
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </Section>
  )
}
