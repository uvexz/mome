import { blobatarUri } from 'blobatar/uri'

/** 头像展示 URL：优先用户自定义 image，否则以用户名生成 blobatar。 */
export function resolveAvatarUrl(
  image: string | null | undefined,
  username: string,
): string {
  return image || blobatarUri(username)
}
