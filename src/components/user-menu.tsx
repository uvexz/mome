import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, DropdownMenu } from '@cloudflare/kumo'
import {
  Archive,
  ArrowsLeftRight,
  Bell,
  GearSix,
  ShieldCheck,
  SignOut,
  Trash,
  UserCircle,
} from '@phosphor-icons/react'

import { authClient } from '#/lib/auth-client'
import {
  adminGateQueryOptions,
  queryKeys,
  unreadNotificationsQueryOptions,
} from '#/lib/queries'

import { Avatar } from './avatar'

/** 顶栏 / 公共主页共用的用户菜单 */
export function UserMenu() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: session } = authClient.useSession()
  const user = session?.user
  const { data: gate } = useQuery({
    ...adminGateQueryOptions(),
    enabled: Boolean(user),
  })
  const { data: unreadResult } = useQuery({
    ...unreadNotificationsQueryOptions(),
    enabled: Boolean(user),
  })
  const showAdmin = Boolean(gate && (gate.isAdmin || !gate.hasAdmin))
  const unread = unreadResult?.count ?? 0
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
            <Avatar
              username={user.username ?? user.name}
              image={user.image}
              size={28}
            />
            <span className="ml-1.5 hidden min-w-0 max-w-[8.5rem] truncate text-sm font-medium sm:inline">
              {user.name}
            </span>
          </Button>
        }
      />
      <DropdownMenu.Content
        sideOffset={6}
        align="end"
        className="w-[min(15rem,calc(100vw-1rem))]"
      >
        <DropdownMenu.Group>
          <DropdownMenu.Label>
            <span className="block truncate text-xs text-kumo-subtle">
              {user.email}
            </span>
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
              queryClient.setQueryData([...queryKeys.notifications, 'unread'], {
                count: 0,
              })
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
        </DropdownMenu.Group>

        <DropdownMenu.Separator />
        <DropdownMenu.Group className="flex items-center gap-1">
          <DropdownMenu.Item
            icon={<SignOut size={16} className="mr-0" />}
            aria-label="退出登录"
            title="退出登录"
            className="mr-auto size-8 justify-center p-0"
            onClick={() => void handleSignOut()}
          >
            <span className="sr-only">退出登录</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={<Archive size={15} />}
            aria-label="归档"
            title="归档"
            className="size-8 justify-center p-0"
            onClick={() =>
              void navigate({
                to: '/',
                search: { filter: 'archived' },
              })
            }
          >
            <span className="sr-only">归档</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={<Trash size={15} />}
            aria-label="回收站"
            title="回收站"
            className="size-8 justify-center p-0"
            onClick={() =>
              void navigate({
                to: '/',
                search: { filter: 'deleted' },
              })
            }
          >
            <span className="sr-only">回收站</span>
          </DropdownMenu.Item>
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
