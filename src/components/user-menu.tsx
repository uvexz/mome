import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button, DropdownMenu } from '@cloudflare/kumo'
import {
  ArrowsLeftRight,
  Bell,
  GearSix,
  ShieldCheck,
  SignOut,
  UserCircle,
} from '@phosphor-icons/react'

import { authClient } from '#/lib/auth-client'
import { getAdminGate } from '#/server/admin'
import { getUnreadNotificationCount } from '#/server/notifications'

import { Avatar } from './avatar'

/** 顶栏 / 公共主页共用的用户菜单（我的主页 / 设置 / 退出登录） */
export function UserMenu() {
  const navigate = useNavigate()
  const { data: session } = authClient.useSession()
  const [showAdmin, setShowAdmin] = useState(false)
  const [unread, setUnread] = useState(0)
  const user = session?.user
  useEffect(() => {
    void getAdminGate()
      .then((gate) => setShowAdmin(gate.isAdmin || !gate.hasAdmin))
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (!user) return
    void getUnreadNotificationCount()
      .then((result) => setUnread(result.count))
      .catch(() => {})
  }, [user])
  if (!user) return null

  async function handleSignOut() {
    await authClient.signOut()
    await navigate({ to: '/explore' })
  }

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            variant="ghost"
            shape="base"
            className="max-w-[12rem] px-2"
            aria-label="用户菜单"
            title={user.name}
          >
            <Avatar image={user.image} email={user.email} size={28} />
            <span className="ml-1.5 hidden min-w-0 max-w-[8.5rem] truncate text-sm font-medium sm:inline">
              {user.name}
            </span>
          </Button>
        }
      />
      <DropdownMenu.Content sideOffset={6} align="end">
        <DropdownMenu.Group>
          <DropdownMenu.Label>
            <span className="block text-xs text-kumo-subtle">{user.email}</span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator />
          {user.username && (
            <DropdownMenu.Item
              icon={<UserCircle size={15} />}
              onClick={() =>
                void navigate({
                  to: '/@{$username}',
                  params: { username: user.username! },
                })
              }
            >
              我的主页
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item
            icon={<Bell size={15} />}
            onClick={() => {
              setUnread(0)
              void navigate({ to: '/notifications' })
            }}
          >
            <span className="flex w-full items-center justify-between gap-4">
              通知
              {unread > 0 && (
                <span className="min-w-5 rounded-full bg-accent px-1.5 text-center font-mono text-[0.9em] text-white">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={<ArrowsLeftRight size={15} />}
            onClick={() => void navigate({ to: '/interactions' })}
          >
            互动
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={<GearSix size={15} />}
            onClick={() => void navigate({ to: '/settings' })}
          >
            设置
          </DropdownMenu.Item>
          {showAdmin && (
            <DropdownMenu.Item
              icon={<ShieldCheck size={15} />}
              onClick={() => void navigate({ to: '/admin' })}
            >
              管理
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            icon={<SignOut size={15} />}
            onClick={() => void handleSignOut()}
          >
            退出登录
          </DropdownMenu.Item>
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
