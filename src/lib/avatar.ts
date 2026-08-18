import { blobatarUri } from 'blobatar/uri'

/** 头像展示 URL：优先用户自定义 image，否则以用户名生成 blobatar。 */
export function resolveAvatarUrl(
  image: string | null | undefined,
  username: string,
): string {
  return image || blobatarUri(username)
}

/** 判断展示值是否为该用户名生成的默认 blobatar。 */
export function isDefaultAvatar(
  image: string | null | undefined,
  username: string,
): boolean {
  return !image || image === blobatarUri(username)
}
