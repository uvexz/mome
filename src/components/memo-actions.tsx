import { Button, DropdownMenu } from '@cloudflare/kumo'
import {
  Archive,
  DotsThree,
  GlobeSimple,
  LockSimple,
  PencilSimple,
  PushPin,
  PushPinSlash,
  Trash,
  TrayArrowUp,
} from '@phosphor-icons/react'

interface MemoActionsProps {
  pinned: boolean
  globalPinned: boolean
  archived: boolean
  visibility: 'public' | 'private'
  onTogglePin?: () => void
  onToggleGlobalPin?: () => void
  onToggleVisibility?: () => void
  onEdit?: () => void
  onToggleArchive?: () => void
  onDelete?: () => void
}

export function MemoActions({
  pinned,
  globalPinned,
  archived,
  visibility,
  onTogglePin,
  onToggleGlobalPin,
  onToggleVisibility,
  onEdit,
  onToggleArchive,
  onDelete,
}: MemoActionsProps) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            variant="ghost"
            shape="square"
            size="xs"
            icon={<DotsThree size={16} />}
            aria-label="memo 操作"
            title="操作"
          />
        }
      />
      <DropdownMenu.Content sideOffset={6} align="end">
        <DropdownMenu.Group>
          {onToggleGlobalPin && (
            <DropdownMenu.Item
              icon={
                globalPinned ? (
                  <PushPinSlash size={15} />
                ) : (
                  <PushPin size={15} />
                )
              }
              onClick={onToggleGlobalPin}
            >
              {globalPinned ? '取消全局置顶' : '全局置顶'}
            </DropdownMenu.Item>
          )}
          {onTogglePin && (
            <DropdownMenu.Item
              icon={pinned ? <PushPinSlash size={15} /> : <PushPin size={15} />}
              onClick={onTogglePin}
            >
              {pinned ? '取消置顶' : '置顶'}
            </DropdownMenu.Item>
          )}
          {onEdit && (
            <DropdownMenu.Item
              icon={<PencilSimple size={15} />}
              onClick={onEdit}
            >
              编辑
            </DropdownMenu.Item>
          )}
          {onToggleVisibility && (
            <DropdownMenu.Item
              icon={
                visibility === 'public' ? (
                  <LockSimple size={15} />
                ) : (
                  <GlobeSimple size={15} />
                )
              }
              onClick={onToggleVisibility}
            >
              {visibility === 'public' ? '设为私密' : '设为公开'}
            </DropdownMenu.Item>
          )}
          {onToggleArchive && (
            <DropdownMenu.Item
              icon={
                archived ? <TrayArrowUp size={15} /> : <Archive size={15} />
              }
              onClick={onToggleArchive}
            >
              {archived ? '取消归档' : '归档'}
            </DropdownMenu.Item>
          )}
          {onDelete && (
            <>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                variant="danger"
                icon={<Trash size={15} />}
                onClick={onDelete}
              >
                删除
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
