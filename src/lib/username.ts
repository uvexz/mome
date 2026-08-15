/**
 * 用户名规则（与 better-auth username 插件保持一致）：
 * 小写字母 / 数字 / 下划线 / 连字符，3-30 位，不能以下划线或连字符开头。
 */

export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 30

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export function isValidUsername(username: string): boolean {
  return (
    username.length >= USERNAME_MIN_LENGTH &&
    username.length <= USERNAME_MAX_LENGTH &&
    USERNAME_RE.test(username)
  )
}
