/** 默认头像（用户未上传头像时使用） */
export const DEFAULT_AVATAR = '/mome.png'

/** 头像展示 URL：优先用户自定义 image，否则使用站点默认头像。 */
export function resolveAvatarUrl(image: string | null | undefined): string {
  return image || DEFAULT_AVATAR
}
