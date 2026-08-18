import {
  createFileRoute,
  redirect,
  useNavigate,
  useSearch,
} from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { startRegistration } from '@simplewebauthn/browser'
import {
  Button,
  ClipboardText,
  Dialog,
  Field,
  Input,
  InputArea,
  LayerCard,
  Loader,
  Select,
  SensitiveInput,
  Sidebar,
  Text,
  useKumoToastManager,
  useSidebar,
} from '@cloudflare/kumo'
import {
  ArrowSquareOut,
  DownloadSimple,
  Fingerprint,
  House,
  BookmarkSimple,
  Key,
  PuzzlePiece,
  ShareNetwork,
  ShieldCheck,
  Trash,
  UploadSimple,
  UserCircle,
  X,
} from '@phosphor-icons/react'
import { z } from 'zod'

import { Avatar } from '#/components/avatar'
import { authClient } from '#/lib/auth-client'
import { buildCaptureBookmarklet } from '#/lib/bookmarklet'
import { relativeTime } from '#/lib/date'
import {
  apiKeysQueryOptions,
  appConfigQueryOptions,
  myProfileQueryOptions,
  queryKeys,
} from '#/lib/queries'
import { uploadPresignedPost } from '#/lib/upload'
import { createApiKey, revokeApiKey } from '#/server/api-keys'
import type { ApiKeyItem } from '#/server/api-keys'
import type { AppConfig } from '#/server/config'
import {
  generatePasskeyRegistrationOptionsFn,
  verifyPasskeyRegistrationFn,
  deletePasskey,
} from '#/server/passkeys'
import { exportMemos, importMemos } from '#/server/memos'
import {
  confirmEmailChange,
  deleteAccount as deleteAccountFn,
  requestEmailChange,
} from '#/server/profile'
import type { getMyProfile } from '#/server/profile'
import type { PasskeyItem } from '#/server/passkeys-core'
import { getSessionUser } from '#/server/session'
import { getUploadUrl } from '#/server/upload'

const settingsSearchSchema = z.object({
  tab: z
    .enum(['general', 'security', 'share', 'api', 'docs'])
    .transform((value) => (value === 'docs' ? 'api' : value))
    .catch('general')
    .optional(),
})

type SettingsTab = 'general' | 'security' | 'share' | 'api'
type NavIcon = React.ComponentType<{ className?: string }>

const SETTINGS_NAV: Array<{
  value: SettingsTab
  label: string
  icon: NavIcon
}> = [
  { value: 'general', label: '通用', icon: UserCircle },
  { value: 'security', label: '安全', icon: ShieldCheck },
  { value: 'share', label: '快速分享', icon: ShareNetwork },
  { value: 'api', label: 'API 及文档', icon: Key },
]

export const Route = createFileRoute('/settings')({
  validateSearch: settingsSearchSchema,
  beforeLoad: async () => {
    const user = await getSessionUser()
    if (!user) throw redirect({ to: '/login' })
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(myProfileQueryOptions()),
      context.queryClient.ensureQueryData(appConfigQueryOptions()),
      context.queryClient.ensureQueryData(apiKeysQueryOptions()),
    ])
  },
  component: SettingsPage,
})

type ProfileData = Awaited<ReturnType<typeof getMyProfile>>

function SettingsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const search = useSearch({ from: '/settings' })
  const { data: profile } = useSuspenseQuery(myProfileQueryOptions())
  const { data: config } = useSuspenseQuery(appConfigQueryOptions())
  const { data: apiKeys } = useSuspenseQuery(apiKeysQueryOptions())
  const { refetch: refetchSession } = authClient.useSession()
  const activeTab: SettingsTab = search.tab ?? 'general'

  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: myProfileQueryOptions().queryKey,
    })
    await queryClient.invalidateQueries({
      queryKey: queryKeys.public,
      refetchType: 'none',
    })
    await refetchSession()
  }

  function go(tab: SettingsTab) {
    void navigate({
      to: '/settings',
      search: { tab },
      replace: true,
    })
  }

  return (
    <SettingsDashboard>
      <SettingsShell
        activeTab={activeTab}
        onNavigate={go}
        profile={profile}
        config={config}
        apiKeys={apiKeys}
        onApiKeysChange={(keys) =>
          queryClient.setQueryData(apiKeysQueryOptions().queryKey, keys)
        }
        refresh={refresh}
      />
    </SettingsDashboard>
  )
}

function SettingsDashboard({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return <SettingsLoading />

  return (
    <Sidebar.Provider collapsible="icon" defaultOpen className="h-dvh">
      {children}
    </Sidebar.Provider>
  )
}

function SettingsLoading() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Loader />
    </div>
  )
}

function SettingsShell({
  activeTab,
  onNavigate,
  profile,
  config,
  apiKeys,
  onApiKeysChange,
  refresh,
}: {
  activeTab: SettingsTab
  onNavigate: (tab: SettingsTab) => void
  profile: ProfileData
  config: AppConfig
  apiKeys: ApiKeyItem[]
  onApiKeysChange: (keys: ApiKeyItem[]) => void
  refresh: () => Promise<void>
}) {
  const navigate = useNavigate()
  const { setOpenMobile } = useSidebar()

  function goAndClose(tab: SettingsTab) {
    setOpenMobile(false)
    onNavigate(tab)
  }

  return (
    <>
      <Sidebar>
        <Sidebar.Header>
          <a href="/" className="flex min-w-0 flex-1 items-center gap-2 px-1.5">
            <img
              src={config.siteIcon}
              alt=""
              className="h-6 w-6 shrink-0 object-contain"
            />
            <span className="truncate text-sm font-semibold text-kumo-strong">
              {config.siteName}
            </span>
          </a>
          <Sidebar.Close className="md:hidden" />
        </Sidebar.Header>
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.GroupLabel>设置</Sidebar.GroupLabel>
            <Sidebar.Menu>
              {SETTINGS_NAV.map((item) => (
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

          {activeTab === 'general' && (
            <div className="grid gap-8">
              <ProfileSection
                profile={profile}
                onSaved={refresh}
                s3Enabled={config.s3Enabled}
              />
              <DataSection />
            </div>
          )}
          {activeTab === 'security' && (
            <div className="grid gap-8">
              <SecuritySection
                profile={profile}
                emailEnabled={config.emailEnabled}
              />
              <PasskeysSection
                passkeys={profile.passkeys}
                onChanged={refresh}
              />
              <DangerSection />
            </div>
          )}
          {activeTab === 'share' && (
            <div className="grid gap-8">
              <BookmarkletSection />
              <WebClipperSection />
            </div>
          )}
          {activeTab === 'api' && (
            <div className="grid gap-8">
              <ApiKeysSection
                initialKeys={apiKeys}
                onChanged={onApiKeysChange}
              />
              <ApiDocsSection />
            </div>
          )}
        </main>
      </div>
    </>
  )
}

function BookmarkletSection() {
  const linkRef = useRef<HTMLAnchorElement>(null)
  const [bookmarklet, setBookmarklet] = useState('')

  useEffect(() => {
    setBookmarklet(buildCaptureBookmarklet(window.location.origin))
  }, [])

  useEffect(() => {
    const link = linkRef.current
    if (!link || !bookmarklet) return
    link.setAttribute('href', bookmarklet)
  }, [bookmarklet])

  return (
    <Section title="快速发布书签">
      <div className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
          <a
            ref={linkRef}
            href="#"
            draggable
            title="拖到浏览器书签栏"
            aria-label="发布到 mome，拖到浏览器书签栏"
            onClick={(event) => {
              if (!bookmarklet) event.preventDefault()
            }}
            className="inline-flex h-8 items-center justify-center gap-2 rounded-md bg-kumo-base px-3 text-sm font-medium text-kumo-default ring ring-kumo-line hover:bg-kumo-tint focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
          >
            <BookmarkSimple size={14} />
            发布到 mome
          </a>
          <ClipboardText
            text="javascript:…"
            textToCopy={bookmarklet}
            size="sm"
            className="w-full"
            tooltip={{
              text: '复制书签代码',
              copiedText: '已复制书签代码',
              side: 'top',
            }}
            labels={{ copyAction: '复制书签代码' }}
          />
        </div>
        <Text variant="secondary" size="sm">
          将此书签拖动到书签栏以快速分享
        </Text>
      </div>
    </Section>
  )
}

function WebClipperSection() {
  const navigate = useNavigate()
  const origin = typeof window === 'undefined' ? '' : window.location.origin

  return (
    <Section
      title="浏览器扩展（Web Clipper）"
      description="Chrome / Edge 扩展，把网页、选中文本和链接一键保存到 mome。"
    >
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="grid gap-4">
          <h3 className="text-sm font-semibold text-kumo-default">安装</h3>
          <ol className="grid list-decimal gap-4 pl-5 marker:font-medium marker:text-kumo-subtle">
            <li>
              <div className="flex flex-wrap items-center gap-2">
                <span>创建 API key，扩展需要它来替你保存内容</span>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-8"
                  onClick={() =>
                    void navigate({
                      to: '/settings',
                      search: { tab: 'api' },
                    })
                  }
                >
                  前往创建
                </Button>
              </div>
            </li>
            <li>
              <div className="grid gap-2">
                <span>获取扩展源码</span>
                <div className="flex flex-wrap gap-2">
                  <a
                    href="https://github.com/uvexz/mome/tree/main/extensions/web-clipper"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-kumo-base px-3 text-sm font-medium text-kumo-default ring ring-kumo-line hover:bg-kumo-tint focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
                  >
                    <PuzzlePiece size={14} />
                    查看 extensions/web-clipper
                    <ArrowSquareOut size={12} />
                  </a>
                  <a
                    href="https://github.com/uvexz/mome/archive/refs/heads/main.zip"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-kumo-base px-3 text-sm font-medium text-kumo-default ring ring-kumo-line hover:bg-kumo-tint focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
                  >
                    <DownloadSimple size={14} />
                    下载仓库 ZIP
                  </a>
                </div>
              </div>
            </li>
            <li>
              <div className="grid gap-2">
                <span>加载扩展</span>
                <Text variant="secondary" size="sm">
                  打开{' '}
                  <code className="rounded bg-kumo-tint px-1 py-0.5 font-mono text-xs">
                    chrome://extensions
                  </code>
                  （Edge 为{' '}
                  <code className="rounded bg-kumo-tint px-1 py-0.5 font-mono text-xs">
                    edge://extensions
                  </code>
                  ），开启右上角「开发者模式」，点击「加载已解压的扩展程序」，选择解压后的{' '}
                  <code className="rounded bg-kumo-tint px-1 py-0.5 font-mono text-xs">
                    extensions/web-clipper
                  </code>{' '}
                  文件夹。
                </Text>
              </div>
            </li>
            <li>
              <div className="grid gap-2">
                <span>填写设置</span>
                <Text variant="secondary" size="sm">
                  点击工具栏的扩展图标 →「设置」，填写实例地址
                  {origin && (
                    <code className="mx-1 rounded bg-kumo-tint px-1 py-0.5 font-mono text-xs">
                      {origin}
                    </code>
                  )}
                  和刚才创建的 API key。
                </Text>
              </div>
            </li>
          </ol>
        </div>

        <div className="grid gap-4">
          <h3 className="text-sm font-semibold text-kumo-default">使用</h3>
          <ul className="grid list-disc gap-4 pl-5 marker:text-kumo-subtle">
            <li>
              <div className="grid gap-1">
                <span className="font-medium">工具栏弹窗</span>
                <Text variant="secondary" size="sm">
                  点击工具栏的 mome
                  图标，编辑标题、摘要或选中文本、标签和可见性，然后保存。
                </Text>
              </div>
            </li>
            <li>
              <div className="grid gap-1">
                <span className="font-medium">右键快速保存</span>
                <Text variant="secondary" size="sm">
                  在网页空白处、选中的文字或链接上右键，选择「保存到
                  mome」立即保存。
                </Text>
              </div>
            </li>
            <li>
              <div className="grid gap-1">
                <span className="font-medium">隐私</span>
                <Text variant="secondary" size="sm">
                  API key 只保存在浏览器本地，不会上传到其他服务。
                </Text>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </Section>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <LayerCard className="grid gap-6 px-5 py-4 text-sm">
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
      {children}
    </LayerCard>
  )
}

// ── 个人资料 ────────────────────────────────────────────
function ProfileSection({
  profile,
  onSaved,
  s3Enabled,
}: {
  profile: ProfileData
  onSaved: () => Promise<void>
  s3Enabled: boolean
}) {
  const toast = useKumoToastManager()
  const [name, setName] = useState(profile.user.name)
  const [bio, setBio] = useState(profile.user.bio ?? '')
  const [image, setImage] = useState<string | null>(profile.user.image)
  const [imageUrl, setImageUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function persistAvatar(nextImage: string | null) {
    const res = await authClient.updateUser({ image: nextImage })
    if (res.error) throw new Error(res.error.message)
    setImage(nextImage)
    await onSaved()
  }

  async function pickFile(file: File | undefined) {
    if (!file) return
    setAvatarBusy(true)
    try {
      const dataUrl = await resizeAvatar(file)
      // resizeAvatar 统一重编码为 JPEG，扩展名必须与真实字节一致，
      // 否则 S3 策略的 Content-Type 断言（image/jpeg）会拒绝上传
      const upload = await getUploadUrl({
        data: { kind: 'avatar', ext: 'jpg' },
      })
      if (upload.mode === 'presigned') {
        const blob = await (await fetch(dataUrl)).blob()
        await uploadPresignedPost(upload, blob)
        await persistAvatar(upload.publicUrl)
      } else {
        await persistAvatar(dataUrl)
      }
      toast.add({ title: '头像已保存', variant: 'success' })
    } catch (err) {
      toast.add({
        title: '头像保存失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    } finally {
      setAvatarBusy(false)
    }
  }

  async function useImageUrl() {
    const url = imageUrl.trim()
    if (!url) return
    // 头像会在他人的公开页被浏览器加载：仅允许 https（或本地相对路径），
    // 拒绝 javascript:/data:/http: 等危险或明文协议
    if (!/^https:\/\//i.test(url) && !url.startsWith('/')) {
      toast.add({
        title: '头像 URL 必须以 https:// 开头',
        variant: 'error',
      })
      return
    }
    setAvatarBusy(true)
    try {
      await persistAvatar(url)
      setImageUrl('')
      toast.add({ title: '头像已保存', variant: 'success' })
    } catch (err) {
      toast.add({
        title: '头像保存失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    } finally {
      setAvatarBusy(false)
    }
  }

  async function removeAvatar() {
    setAvatarBusy(true)
    try {
      await persistAvatar(null)
      toast.add({ title: '头像已移除', variant: 'success' })
    } catch (err) {
      toast.add({
        title: '头像保存失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    } finally {
      setAvatarBusy(false)
    }
  }

  async function save() {
    setSaving(true)
    try {
      const res = await authClient.updateUser({
        name: name.trim() || profile.user.name,
        bio: bio.trim() || undefined,
      })
      if (res.error) throw new Error(res.error.message)
      await onSaved()
      toast.add({ title: '已保存', variant: 'success' })
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

  return (
    <Section
      title="个人资料"
      description="头像、昵称和简介会展示在你的公开主页。"
    >
      <div className="grid gap-4">
        <div className="flex items-center gap-4">
          <Avatar
            username={profile.user.username ?? profile.user.name}
            image={image}
            size={56}
            animate="always"
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void pickFile(e.target.files?.[0])}
              aria-label="上传头像"
            />
            {s3Enabled ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<UploadSimple size={14} />}
                onClick={() => fileRef.current?.click()}
                loading={avatarBusy}
                disabled={avatarBusy}
                className="h-8"
              >
                上传头像
              </Button>
            ) : (
              <Text
                variant="secondary"
                size="sm"
                DANGEROUS_className="max-w-52"
              >
                未配置 S3，暂不支持上传头像，可使用图片 URL。
              </Text>
            )}
            {image && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash size={14} />}
                onClick={() => void removeAvatar()}
                loading={avatarBusy}
                disabled={avatarBusy}
                className="h-8"
              >
                移除
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="url"
            placeholder="或粘贴头像图片 URL"
            aria-label="头像 URL"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            className="h-8 flex-1 text-sm"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!imageUrl.trim() || avatarBusy}
            loading={avatarBusy}
            onClick={() => void useImageUrl()}
            className="h-8"
          >
            使用
          </Button>
        </div>
        <Field label="昵称">
          <Input
            aria-label="昵称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 text-sm"
          />
        </Field>
        <Field label="用户名" description="注册后不可更改，作为公开主页地址">
          <Input
            aria-label="用户名"
            value={profile.user.username ?? ''}
            disabled
            className="h-8 font-mono text-sm"
          />
        </Field>
        <Field label="简介">
          <InputArea
            aria-label="简介"
            placeholder="介绍一下自己…"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            className="min-h-20 w-full resize-y px-4 py-2 text-sm"
            maxLength={200}
          />
        </Field>
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            disabled={avatarBusy}
            onClick={() => void save()}
            className="h-8"
          >
            保存
          </Button>
        </div>
      </div>
    </Section>
  )
}

function resizeAvatar(file: File): Promise<string> {
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
        resolve(canvas.toDataURL('image/jpeg', 0.85))
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

// ── 安全：邮箱 / 密码 ───────────────────────────────────
function SecuritySection({
  profile,
  emailEnabled,
}: {
  profile: ProfileData
  emailEnabled: boolean
}) {
  const toast = useKumoToastManager()
  const [newEmail, setNewEmail] = useState('')
  const [emailPassword, setEmailPassword] = useState('')
  const [newOtp, setNewOtp] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)

  async function sendNewEmailOtp() {
    setEmailBusy(true)
    try {
      await requestEmailChange({
        data: { newEmail, password: emailPassword },
      })
      toast.add({ title: '验证码已发送到新邮箱', variant: 'success' })
    } catch (err) {
      toast.add({
        title: '发送失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    } finally {
      setEmailBusy(false)
    }
  }

  async function handleConfirmEmailChange() {
    setEmailBusy(true)
    try {
      await confirmEmailChange({
        data: { newEmail, otp: newOtp },
      })
      toast.add({ title: '邮箱已更新', variant: 'success' })
      setNewEmail('')
      setEmailPassword('')
      setNewOtp('')
    } catch (err) {
      toast.add({
        title: '更换失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    } finally {
      setEmailBusy(false)
    }
  }

  async function changePassword() {
    if (newPassword.length < 8) {
      toast.add({ title: '新密码至少 8 位', variant: 'error' })
      return
    }
    setPasswordBusy(true)
    try {
      const res = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      })
      if (res.error) throw new Error(res.error.message)
      toast.add({ title: '密码已更新', variant: 'success' })
      setCurrentPassword('')
      setNewPassword('')
    } catch (err) {
      toast.add({
        title: '修改失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    } finally {
      setPasswordBusy(false)
    }
  }

  return (
    <Section title="安全" description="邮箱与密码管理。">
      <div className="grid gap-5">
        {emailEnabled ? (
          <div className="grid gap-3">
            <h3 className="text-sm font-semibold text-kumo-default">邮箱</h3>
            <p className="font-mono text-sm text-kumo-subtle">
              {profile.user.email}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="新邮箱">
                <Input
                  type="email"
                  aria-label="新邮箱"
                  placeholder="new@example.com"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="h-8 text-sm"
                />
              </Field>
              <Field label="当前密码">
                <SensitiveInput
                  aria-label="当前密码"
                  autoComplete="current-password"
                  value={emailPassword}
                  onChange={(e) => setEmailPassword(e.target.value)}
                  className="h-8 text-sm"
                />
              </Field>
            </div>
            <Text variant="secondary" size="sm" DANGEROUS_className="-mt-1">
              验证身份后向新邮箱发送验证码。
            </Text>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <Field label="新邮箱验证码">
                <Input
                  inputMode="numeric"
                  aria-label="新邮箱验证码"
                  placeholder="6 位数字"
                  value={newOtp}
                  onChange={(e) =>
                    setNewOtp(e.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  className="h-8 font-mono text-sm"
                />
              </Field>
              <div className="flex items-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={emailBusy}
                  disabled={!newEmail.trim() || !emailPassword}
                  onClick={() => void sendNewEmailOtp()}
                  className="h-8"
                >
                  发送验证码
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={emailBusy}
                  disabled={!newEmail.trim() || !newOtp.trim()}
                  onClick={() => void handleConfirmEmailChange()}
                  className="h-8"
                >
                  确认更换
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid gap-1">
            <h3 className="text-sm font-semibold text-kumo-default">邮箱</h3>
            <p className="font-mono text-sm text-kumo-subtle">
              {profile.user.email}
            </p>
            <Text variant="secondary" size="sm">
              未配置邮件服务，暂不支持更换邮箱。
            </Text>
          </div>
        )}

        <div className="grid gap-3 border-t border-kumo-line pt-5">
          <h3 className="text-sm font-semibold text-kumo-default">密码</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="当前密码">
              <SensitiveInput
                aria-label="当前密码"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="h-8 text-sm"
              />
            </Field>
            <Field label="新密码">
              <SensitiveInput
                aria-label="新密码"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="h-8 text-sm"
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              loading={passwordBusy}
              disabled={!currentPassword || !newPassword}
              onClick={() => void changePassword()}
              className="h-8"
            >
              修改密码
            </Button>
          </div>
        </div>
      </div>
    </Section>
  )
}

// ── Passkey ─────────────────────────────────────────────
function PasskeysSection({
  passkeys,
  onChanged,
}: {
  passkeys: PasskeyItem[]
  onChanged: () => Promise<void>
}) {
  const toast = useKumoToastManager()
  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)

  async function addPasskey() {
    setAdding(true)
    try {
      const options = await generatePasskeyRegistrationOptionsFn()
      const response = await startRegistration({
        optionsJSON: options.options,
      })
      await verifyPasskeyRegistrationFn({
        data: {
          challengeId: options.challengeId,
          name: name.trim() || 'Passkey',
          response,
        },
      })
      setName('')
      await onChanged()
      toast.add({ title: 'Passkey 已添加', variant: 'success' })
    } catch (err) {
      toast.add({
        title: '添加失败',
        description:
          err instanceof Error && err.name !== 'NotAllowedError'
            ? err.message
            : '已取消，或设备不支持 Passkey',
        variant: 'error',
      })
    } finally {
      setAdding(false)
    }
  }

  async function removePasskey(id: string) {
    try {
      await deletePasskey({ data: { credentialId: id } })
      await onChanged()
      toast.add({ title: '已删除', variant: 'success' })
    } catch {
      toast.add({ title: '删除失败', variant: 'error' })
    }
  }

  return (
    <Section title="Passkey" description="用指纹、面容或安全密钥免密登录。">
      <div className="grid gap-3">
        {passkeys.length === 0 ? (
          <p className="text-sm text-kumo-subtle">还没有 Passkey。</p>
        ) : (
          <div className="grid gap-2">
            {passkeys.map((p) => (
              <div
                key={p.id}
                className="flex items-start gap-2 rounded-lg bg-kumo-tint px-4 py-2.5"
              >
                <span className="h-lh flex shrink-0 items-center text-kumo-subtle">
                  <Fingerprint size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-kumo-default">
                    {p.name}
                  </p>
                  <p className="font-mono text-xs text-kumo-subtle">
                    添加于 {relativeTime(p.createdAt)}
                    {p.lastUsedAt
                      ? ` · 最近使用 ${relativeTime(p.lastUsedAt)}`
                      : ''}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  shape="square"
                  size="sm"
                  icon={<Trash size={14} />}
                  aria-label={`删除 ${p.name}`}
                  onClick={() => void removePasskey(p.id)}
                  className="h-8 w-8 self-center"
                />
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Input
            aria-label="Passkey 名称"
            placeholder="名称（可选）"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 max-w-52 text-sm"
          />
          <Button
            variant="secondary"
            size="sm"
            icon={<Fingerprint size={14} />}
            loading={adding}
            onClick={() => void addPasskey()}
            className="h-8"
          >
            添加 Passkey
          </Button>
        </div>
      </div>
    </Section>
  )
}

// ── API keys ────────────────────────────────────────────
const EXPIRY_OPTIONS = {
  never: '永不过期',
  '30d': '30 天',
  '90d': '90 天',
  '365d': '1 年',
} as const

type ExpiryValue = keyof typeof EXPIRY_OPTIONS

function expiryDate(value: ExpiryValue): string | undefined {
  if (value === 'never') return undefined
  const days = value === '30d' ? 30 : value === '90d' ? 90 : 365
  return new Date(Date.now() + days * 86_400_000).toISOString()
}

function ApiKeysSection({
  initialKeys,
  onChanged,
}: {
  initialKeys: ApiKeyItem[]
  onChanged: (keys: ApiKeyItem[]) => void
}) {
  const toast = useKumoToastManager()
  const [keys, setKeys] = useState<ApiKeyItem[]>(initialKeys)
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState<ExpiryValue>('never')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ token: string } | null>(null)
  const [createdOpen, setCreatedOpen] = useState(false)
  const [revoking, setRevoking] = useState<ApiKeyItem | null>(null)
  const [revokeOpen, setRevokeOpen] = useState(false)

  function updateKeys(next: ApiKeyItem[]) {
    setKeys(next)
    onChanged(next)
  }

  async function handleCreate() {
    if (!name.trim()) {
      toast.add({ title: '请输入 API key 名称', variant: 'error' })
      return
    }
    setCreating(true)
    try {
      const res = await createApiKey({
        data: { name: name.trim(), expiresAt: expiryDate(expiry) },
      })
      updateKeys([res.key, ...keys])
      setCreated({ token: res.token })
      setCreatedOpen(true)
      setName('')
    } catch (err) {
      toast.add({
        title: '创建失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    } finally {
      setCreating(false)
    }
  }

  async function confirmRevoke() {
    if (!revoking) return
    try {
      await revokeApiKey({ data: { id: revoking.id } })
      updateKeys(keys.filter((key) => key.id !== revoking.id))
      setRevokeOpen(false)
      setRevoking(null)
      toast.add({ title: '已撤销', variant: 'success' })
    } catch {
      toast.add({ title: '撤销失败', variant: 'error' })
    }
  }

  return (
    <Section
      title="API keys"
      description="创建 API key 后，可通过 /v1 接口发布与读取 memo。密钥只显示一次，请妥善保存。"
    >
      <div className="grid gap-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,8rem)_auto] sm:items-end">
          <div className="min-w-0">
            <Field label="名称">
              <Input
                aria-label="API key 名称"
                placeholder="例如：我的脚本"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8 text-sm"
                maxLength={60}
              />
            </Field>
          </div>
          <div className="min-w-0">
            <Field label="有效期">
              <Select
                size="sm"
                className="h-8"
                value={expiry}
                onValueChange={(value) => setExpiry(value ?? 'never')}
              >
                {Object.entries(EXPIRY_OPTIONS).map(([value, label]) => (
                  <Select.Option key={value} value={value}>
                    {label}
                  </Select.Option>
                ))}
              </Select>
            </Field>
          </div>
          <Button
            variant="primary"
            size="sm"
            icon={<Key size={14} />}
            loading={creating}
            onClick={() => void handleCreate()}
            className="h-8 w-full sm:w-auto"
          >
            创建 API key
          </Button>
        </div>

        {keys.length === 0 ? (
          <Text variant="secondary" size="sm">
            还没有 API key，创建后即可调用 /v1 接口。
          </Text>
        ) : (
          <div className="grid gap-2">
            {keys.map((key) => (
              <div
                key={key.id}
                className="flex items-start gap-2 rounded-lg bg-kumo-tint px-4 py-2.5"
              >
                <span className="h-lh flex shrink-0 items-center text-kumo-subtle">
                  <Key size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-kumo-default">
                    {key.name}
                  </p>
                  <p className="truncate font-mono text-xs text-kumo-subtle">
                    {key.keyPrefix}… · 创建于 {relativeTime(key.createdAt)}
                    {key.lastUsedAt
                      ? ` · 最近使用 ${relativeTime(key.lastUsedAt)}`
                      : ''}
                    {key.expiresAt
                      ? ` · 过期于 ${new Date(key.expiresAt).toLocaleDateString('zh-CN')}`
                      : ''}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  shape="square"
                  size="sm"
                  icon={<Trash size={14} />}
                  aria-label={`撤销 ${key.name}`}
                  onClick={() => {
                    setRevoking(key)
                    setRevokeOpen(true)
                  }}
                  className="h-8 w-8 self-center"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog.Root open={createdOpen} onOpenChange={setCreatedOpen}>
        <Dialog className="p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <Dialog.Title className="text-base font-semibold">
              API key 已创建
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
            密钥只显示这一次，关闭后无法再次查看。请立即复制并妥善保存。
          </Dialog.Description>
          {created && (
            <div className="mt-4">
              <ClipboardText
                text={created.token}
                size="sm"
                className="w-full"
              />
            </div>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button variant="primary" {...props}>
                  我已保存
                </Button>
              )}
            />
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root open={revokeOpen} onOpenChange={setRevokeOpen}>
        <Dialog className="p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <Dialog.Title className="text-base font-semibold">
              撤销 API key
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
            撤销后使用该 key 的请求会立即失败，且无法恢复。确定撤销{' '}
            <span className="font-medium text-kumo-default">
              {revoking?.name}
            </span>{' '}
            吗？
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
              icon={<Trash size={14} />}
              onClick={() => void confirmRevoke()}
            >
              确认撤销
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </Section>
  )
}

// ── API 文档 ────────────────────────────────────────────
function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="max-w-full overflow-x-auto rounded-lg bg-kumo-tint px-4 py-3 font-mono text-sm leading-6 text-kumo-default">
      <code>{code}</code>
    </pre>
  )
}

function ApiDocsSection() {
  return (
    <Section
      title="API 文档"
      description="mome 开放 API，所有端点以 /v1 开头，使用 API key 认证。"
    >
      <div className="grid gap-6">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-kumo-default">认证</h3>
          <Text variant="secondary" size="sm" DANGEROUS_className="mt-1">
            在请求头中携带 API key。key 请在本页上方「API keys」区域创建。
          </Text>
          <div className="mt-2">
            <CodeBlock code={`Authorization: Bearer mome_xxxxxxxxxxxxxxxx`} />
          </div>
        </div>

        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-kumo-default">
            Memos 接口
          </h3>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[480px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-kumo-line text-xs text-kumo-subtle">
                  <th className="py-2 pr-4 font-medium">方法</th>
                  <th className="py-2 pr-4 font-medium">路径</th>
                  <th className="py-2 font-medium">说明</th>
                </tr>
              </thead>
              <tbody className="font-mono text-sm">
                {[
                  ['GET', '/v1/me', '当前用户信息'],
                  ['GET', '/v1/memos', '分页列出 memo'],
                  ['POST', '/v1/memos', '发布 memo'],
                  ['POST', '/v1/clips', '保存网页剪藏'],
                  ['GET', '/v1/memos/:id', '获取单条 memo'],
                  ['PATCH', '/v1/memos/:id', '更新 memo'],
                  ['DELETE', '/v1/memos/:id', '删除 memo'],
                  ['GET', '/v1/tags', '标签列表'],
                  ['GET', '/v1/stats', '统计信息'],
                ].map(([method, path, desc]) => (
                  <tr
                    key={`${method}-${path}`}
                    className="border-b border-kumo-line/60"
                  >
                    <td className="py-2 pr-4">
                      <span
                        className={
                          method === 'GET'
                            ? 'text-kumo-subtle'
                            : method === 'POST'
                              ? 'text-kumo-default'
                              : 'text-kumo-default'
                        }
                      >
                        {method}
                      </span>
                    </td>
                    <td className="py-2 pr-4">{path}</td>
                    <td className="py-2 font-sans text-kumo-subtle">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-kumo-default">发布 memo</h3>
          <div className="mt-2 grid gap-2">
            <CodeBlock
              code={`curl -X POST "$BASE_URL/v1/memos" \\
  -H "Authorization: Bearer $MOME_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"content": "你好，mome API！", "visibility": "public"}'`}
            />
            <CodeBlock
              code={`const res = await fetch('https://你的域名/v1/memos', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer mome_xxxx',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ content: '你好，mome API！' }),
})
const memo = await res.json()`}
            />
          </div>
        </div>

        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-kumo-default">查询参数</h3>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[480px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-kumo-line text-xs text-kumo-subtle">
                  <th className="py-2 pr-4 font-medium">参数</th>
                  <th className="py-2 pr-4 font-medium">说明</th>
                  <th className="py-2 font-medium">默认</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {[
                  ['cursor', '分页游标（来自上一页 nextCursor）', '—'],
                  ['limit', '每页数量，1–50', '20'],
                  ['tag', '按 #标签 筛选', '—'],
                  ['q', '全文搜索', '—'],
                  ['filter', 'all / archived / deleted', 'all'],
                ].map(([param, desc, def]) => (
                  <tr key={param} className="border-b border-kumo-line/60">
                    <td className="py-2 pr-4 font-mono">{param}</td>
                    <td className="py-2 pr-4 text-kumo-subtle">{desc}</td>
                    <td className="py-2 font-mono text-kumo-subtle">{def}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-kumo-default">错误</h3>
          <Text variant="secondary" size="sm" DANGEROUS_className="mt-1">
            失败时返回非 2xx 状态码和统一的错误结构：
          </Text>
          <div className="mt-2">
            <CodeBlock
              code={`{ "error": { "code": "invalid_api_key", "message": "API key 无效、已过期或已撤销" } }`}
            />
          </div>
          <div className="mt-2 grid gap-2">
            {[
              ['401', 'unauthorized / invalid_api_key'],
              ['404', 'memo_not_found'],
              ['400', 'validation_error / invalid_json'],
              ['500', 'internal_error'],
            ].map(([status, code]) => (
              <div key={code} className="flex gap-3 text-sm">
                <span className="w-10 shrink-0 font-mono text-kumo-subtle">
                  {status}
                </span>
                <span className="font-mono text-kumo-default">{code}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  )
}

// ── 数据导入 / 导出 ─────────────────────────────────────
async function downloadMemosExport(): Promise<number> {
  const memos = await exportMemos()
  const payload = JSON.stringify(
    { version: 1, exportedAt: new Date().toISOString(), memos },
    null,
    2,
  )
  const url = URL.createObjectURL(
    new Blob([payload], { type: 'application/json' }),
  )
  const a = document.createElement('a')
  a.href = url
  a.download = `mome-memos-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
  return memos.length
}

function DataSection() {
  const queryClient = useQueryClient()
  const toast = useKumoToastManager()
  const fileRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  async function handleExport() {
    try {
      const count = await downloadMemosExport()
      toast.add({ title: `已导出 ${count} 条 memo`, variant: 'success' })
    } catch {
      toast.add({ title: '导出失败', variant: 'error' })
    }
  }

  async function handleImport(file: File | undefined) {
    if (!file) return
    setImporting(true)
    try {
      const text = await file.text()
      const parsed: unknown = JSON.parse(text)
      const memos = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === 'object' &&
            'memos' in parsed &&
            Array.isArray(parsed.memos)
          ? parsed.memos
          : null
      if (!memos) throw new Error('JSON 格式不正确')
      const res = await importMemos({ data: { memos } })
      for (const queryKey of [
        queryKeys.memos,
        queryKeys.tags,
        queryKeys.stats,
        queryKeys.contribution,
      ]) {
        void queryClient.invalidateQueries({ queryKey, refetchType: 'none' })
      }
      toast.add({
        title: `导入完成：新增 ${res.imported} 条，跳过 ${res.skipped} 条`,
        variant: 'success',
      })
    } catch (err) {
      toast.add({
        title: '导入失败',
        description: err instanceof Error ? err.message : '请检查 JSON 文件',
        variant: 'error',
      })
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <Section title="数据" description="导出为 JSON 可随时备份或迁移。">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => void handleImport(e.target.files?.[0])}
          aria-label="导入 memo JSON"
        />
        <Button
          variant="secondary"
          size="sm"
          icon={<DownloadSimple size={14} />}
          onClick={() => void handleExport()}
          className="h-8"
        >
          导出 JSON
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<UploadSimple size={14} />}
          loading={importing}
          onClick={() => fileRef.current?.click()}
          className="h-8"
        >
          导入 JSON
        </Button>
      </div>
    </Section>
  )
}

// ── 注销账号 ────────────────────────────────────────────
function DangerSection() {
  const toast = useKumoToastManager()
  const [password, setPassword] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [dangerOpen, setDangerOpen] = useState(false)
  const [dangerStep, setDangerStep] = useState<'confirm' | 'export'>('confirm')

  async function handleDeleteAccount() {
    if (!password) return
    setDeleting(true)
    try {
      await deleteAccountFn({ data: { password } })
      // 清理会话 cookie 后整页跳转，确保全新未登录状态
      document.cookie =
        'better-auth.session_token=; Max-Age=0; path=/; SameSite=Lax'
      window.location.href = '/signup'
    } catch (err) {
      toast.add({
        title: '注销失败',
        description: err instanceof Error ? err.message : '请稍后重试',
        variant: 'error',
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Section
      title="注销账号"
      description="注销后所有 memo、评论与 Passkey 将被永久删除。"
    >
      <div className="flex items-center gap-2">
        <SensitiveInput
          aria-label="当前密码"
          autoComplete="current-password"
          placeholder="输入当前密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-8 min-w-0 flex-1 text-sm"
        />
        <Button
          variant="destructive"
          size="sm"
          icon={<Trash size={14} />}
          disabled={!password || deleting}
          onClick={() => {
            setDangerStep('confirm')
            setDangerOpen(true)
          }}
          className="h-8 shrink-0"
        >
          注销账号
        </Button>
      </div>

      <Dialog.Root open={dangerOpen} onOpenChange={setDangerOpen}>
        <Dialog className="p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <Dialog.Title className="text-base font-semibold">
              {dangerStep === 'confirm' ? '注销账号' : '是否已经导出相关数据？'}
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

          {dangerStep === 'confirm' ? (
            <>
              <Dialog.Description className="text-sm text-kumo-subtle">
                删除后所有 memo、评论、点赞、收藏、转发与 Passkey 将被永久删除，
                无法恢复。确定要删除吗？
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
                  onClick={() => setDangerStep('export')}
                >
                  继续
                </Button>
              </div>
            </>
          ) : (
            <>
              <Dialog.Description className="text-sm text-kumo-subtle">
                建议先导出 JSON 备份。是否已经导出相关数据？
              </Dialog.Description>
              <div className="mt-6 flex flex-wrap justify-end gap-2">
                <Dialog.Close
                  render={(props) => (
                    <Button variant="secondary" {...props}>
                      取消
                    </Button>
                  )}
                />
                <Button
                  variant="secondary"
                  icon={<DownloadSimple size={14} />}
                  onClick={async () => {
                    try {
                      const count = await downloadMemosExport()
                      toast.add({
                        title: `已导出 ${count} 条 memo`,
                        variant: 'success',
                      })
                    } catch {
                      toast.add({ title: '导出失败', variant: 'error' })
                    }
                  }}
                >
                  导出 JSON
                </Button>
                <Button
                  variant="destructive"
                  icon={<Trash size={14} />}
                  loading={deleting}
                  onClick={() => void handleDeleteAccount()}
                >
                  确认删除
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Dialog.Root>
    </Section>
  )
}
