/**
 * 服务端能力开关（纯函数，无外部依赖，客户端可安全引用）。
 */

/** 邮件投递是否可用：SMTP / Resend / 显式开发模式 */
export function isEmailDeliveryEnabled(): boolean {
  if (process.env.MOME_EMAIL_DEV === 'console') return true
  if (process.env.SMTP_HOST) return true
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM)
}

/** S3 是否已配置；未配置时图片上传功能关闭（头像保留 URL 方式） */
export function isS3Enabled(): boolean {
  return Boolean(
    process.env.S3_ENDPOINT &&
    process.env.S3_BUCKET &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY,
  )
}
