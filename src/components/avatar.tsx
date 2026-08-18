import { useEffect, useState } from 'react'

import { resolveAvatarUrl } from '#/lib/avatar'
import { cn } from '#/lib/utils'

interface AvatarProps {
  /** 用户名，用作默认 blobatar 的 seed */
  username: string
  /** 自定义头像 URL（设置页上传后使用） */
  image?: string | null
  /** 头像尺寸（px），默认 28 */
  size?: number
  className?: string
}

/**
 * 用户头像：优先使用自定义 image，加载失败或缺失时按用户名生成 blobatar。
 */
export function Avatar({ username, image, size = 28, className }: AvatarProps) {
  const [src, setSrc] = useState<string>(() =>
    resolveAvatarUrl(image, username),
  )

  useEffect(() => {
    setSrc(resolveAvatarUrl(image, username))
  }, [image, username])

  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      onError={() => {
        const fallback = resolveAvatarUrl(null, username)
        if (src !== fallback) setSrc(fallback)
      }}
      className={cn(
        'rounded-full object-cover ring-1 ring-kumo-line',
        className,
      )}
      style={{ width: size, height: size }}
    />
  )
}
