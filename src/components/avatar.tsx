import { Blobatar } from 'blobatar/react'
import 'blobatar/motion.css'
import { useEffect, useState } from 'react'

import { isDefaultAvatar } from '#/lib/avatar'
import { cn } from '#/lib/utils'

interface AvatarProps {
  /** 用户名，用作默认 blobatar 的 seed */
  username: string
  /** 自定义头像 URL（设置页上传后使用） */
  image?: string | null
  /** 头像尺寸（px），默认 28 */
  size?: number
  /** 默认头像的运动方式，列表中默认 hover */
  animate?: 'always' | 'hover'
  className?: string
}

/**
 * 用户头像：优先使用自定义 image，加载失败或缺失时显示动态 blobatar。
 */
export function Avatar({
  username,
  image,
  size = 28,
  animate = 'hover',
  className,
}: AvatarProps) {
  const [src, setSrc] = useState<string | null>(() =>
    isDefaultAvatar(image, username) ? null : (image ?? null),
  )

  useEffect(() => {
    setSrc(isDefaultAvatar(image, username) ? null : (image ?? null))
  }, [image, username])

  const classes = cn(
    'rounded-full object-cover ring-1 ring-kumo-line',
    className,
  )

  if (!src) {
    return (
      <Blobatar
        name={username}
        animate={animate}
        size={size}
        className={classes}
      />
    )
  }

  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      onError={() => setSrc(null)}
      className={classes}
      style={{ width: size, height: size }}
    />
  )
}
