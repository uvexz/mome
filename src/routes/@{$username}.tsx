import { Outlet, createFileRoute } from '@tanstack/react-router'

/**
 * 公开主页布局：/@username 展示个人主页，
 * /@username/:memoId 展示 memo 详情页。
 */
export const Route = createFileRoute('/@{$username}')({
  component: PublicLayout,
})

function PublicLayout() {
  return <Outlet />
}
