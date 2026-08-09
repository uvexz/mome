import { useState } from 'react'

import { DEFAULT_AVATAR, resolveAvatarUrl } from '#/lib/avatar'
import { cn } from '#/lib/utils'

interface AvatarProps {
  email?: string | null
  /** 自定义头像 URL（设置页上传后使用） */
  image?: string | null
  /** 头像尺寸（px），默认 28 */
  size?: number
  className?: string
}

/**
 * 用户头像：优先使用自定义 image，其次 gravatar（https://cdn.sevencdn.com/avatar/HASH），
 * 加载失败或缺失时回退到 /mome.png。
 */
export function Avatar({ email, image, size = 28, className }: AvatarProps) {
  const [src, setSrc] = useState<string>(() => resolveAvatarUrl(image, email))

  const fallback = resolveAvatarUrl(null, email)

  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      onError={() => {
        if (src !== fallback) setSrc(fallback)
        else if (src !== DEFAULT_AVATAR) setSrc(DEFAULT_AVATAR)
      }}
      className={cn(
        'rounded-full object-cover ring-1 ring-kumo-line',
        className,
      )}
      style={{ width: size, height: size }}
    />
  )
}
