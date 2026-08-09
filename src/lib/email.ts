/**
 * OTP 邮件发送。
 * - 配置了 SMTP_HOST 时走 SMTP（nodemailer）
 * - 否则配置了 RESEND_API_KEY + RESEND_FROM 时走 Resend API
 * - 否则输出到服务端日志（开发环境）
 */
import nodemailer from 'nodemailer'

import { loadEmailSettings, loadSiteSettings } from '#/server/settings-core'

const RESEND_URL = 'https://api.resend.com/emails'

function subjectFor(type: string, siteName: string): string {
  switch (type) {
    case 'sign-in':
      return `【${siteName}】登录验证码`
    case 'change-email':
      return `【${siteName}】更换邮箱验证码`
    case 'email-verification':
      return `【${siteName}】邮箱验证码`
    case 'forget-password':
      return `【${siteName}】重置密码验证码`
    default:
      return `【${siteName}】验证码`
  }
}

function otpHtml(otp: string, siteName: string): string {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="font-size:18px;margin:0 0 12px">${siteName} 验证码</h2>
      <p style="font-size:14px;color:#555">你的验证码是：</p>
      <p style="font-size:28px;font-weight:600;letter-spacing:6px;margin:16px 0">${otp}</p>
      <p style="font-size:13px;color:#999">5 分钟内有效。如果这不是你的操作，请忽略这封邮件。</p>
    </div>
  `
}

export async function sendOtpEmail({
  email,
  otp,
  type,
}: {
  email: string
  otp: string
  type: string
}): Promise<void> {
  const [settings, site] = await Promise.all([
    loadEmailSettings(),
    loadSiteSettings(),
  ])
  const subject = subjectFor(type, site.name)
  const html = otpHtml(otp, site.name)

  if (settings.provider === 'smtp') {
    const transporter = nodemailer.createTransport({
      host: settings.smtp.host,
      port: settings.smtp.port,
      secure: settings.smtp.secure,
      auth:
        settings.smtp.user || settings.smtp.password
          ? {
              user: settings.smtp.user,
              pass: settings.smtp.password,
            }
          : undefined,
    })
    await transporter.sendMail({
      from: settings.smtp.from,
      to: email,
      subject,
      html,
    })
    return
  }

  if (settings.provider === 'resend') {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.resend.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: settings.resend.from,
        to: email,
        subject,
        html,
      }),
    })
    if (!res.ok) {
      console.error('[mome OTP] Resend 发送失败', res.status, await res.text())
    }
    return
  }

  // 未配置邮件服务：生产环境静默，开发环境打印到服务端日志
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[mome OTP] type=${type} email=${email} otp=${otp}`)
  }
}
