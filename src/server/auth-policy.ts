/**
 * 各认证入口共享的登录策略。
 *
 * 邮箱验证要求必须在所有密码登录入口生效（email、username、兼容层 signin），
 * 而不是只写在某一个路由包装器里；运行时开关（邮件是否可用）保持即时生效。
 */
import { eq } from 'drizzle-orm'

import { db } from '#/db'
import { user } from '#/db/schema'
import { loadEmailSettings } from './settings-core'

export interface PasswordLoginIdentifier {
  email?: string
  username?: string
}

/**
 * 邮件功能启用时，未验证邮箱的账号不允许密码登录。
 * 返回 true 表示应当拒绝；调用方需要返回与"账号不存在"一致的响应，
 * 避免通过差异响应枚举"已注册但未验证"的账号。
 */
export async function isPasswordLoginBlocked(
  identifier: PasswordLoginIdentifier,
): Promise<boolean> {
  const emailSettings = await loadEmailSettings()
  if (!emailSettings.enabled) return false

  const email = identifier.email?.trim().toLowerCase()
  const username = identifier.username?.trim().toLowerCase()
  if (!email && !username) return false

  const existing = await db.query.user.findFirst({
    where: email ? eq(user.email, email) : eq(user.username, username!),
    columns: { emailVerified: true },
  })
  return Boolean(existing && !existing.emailVerified)
}
