import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { emailOTP, oneTimeToken, username } from 'better-auth/plugins'

import { db } from '#/db'
import { sendOtpEmail } from '#/lib/email'

const authUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000'

// 生产环境 fail-fast：漏配 BETTER_AUTH_URL 会让 trustedOrigins/passkey RP
// 回退到 localhost，登录 Origin 校验与 passkey 全部异常（且错误静默）。
if (process.env.NODE_ENV === 'production') {
  if (!process.env.BETTER_AUTH_URL) {
    throw new Error('生产环境必须设置 BETTER_AUTH_URL（站点公开地址）')
  }
  const parsed = new URL(process.env.BETTER_AUTH_URL)
  const isLocalhost =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !isLocalhost) {
    throw new Error('生产环境 BETTER_AUTH_URL 必须以 https:// 开头')
  }
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'sqlite' }),
  emailAndPassword: {
    enabled: true,
    // 是否必须验证邮箱由运行时邮件配置决定（见 /api/auth/$ 的请求守卫）
    requireEmailVerification: false,
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
  },
  user: {
    additionalFields: {
      bio: {
        type: 'string',
        required: false,
        input: true,
        returned: true,
      },
    },
    // 注销账号：需要当前密码（会话非 fresh 时）
    deleteUser: { enabled: true },
  },
  plugins: [
    username({
      minUsernameLength: 3,
      maxUsernameLength: 30,
      usernameValidator: (value: string) => /^[a-z0-9][a-z0-9_-]*$/.test(value),
    }),
    emailOTP({
      otpLength: 6,
      expiresIn: 300,
      // OTP 落库前哈希，避免数据库/备份泄露即直接拿到可用验证码
      storeOTP: 'hashed',
      // OTP 只用于已有账号登录，新用户走邮箱密码 + 用户名注册
      disableSignUp: true,
      // 注册后由核心流程发送 OTP（覆盖默认邮件验证）
      sendVerificationOnSignUp: false,
      overrideDefaultEmailVerification: true,
      sendVerificationOTP: async ({ email, otp, type }) => {
        await sendOtpEmail({ email, otp, type })
      },
      changeEmail: {
        enabled: true,
        // 邮箱更换走自定义流程：校验当前密码 + 新邮箱 OTP
        verifyCurrentEmail: false,
      },
    }),
    // passkey 验证通过后生成一次性令牌，由客户端换取会话
    oneTimeToken({ expiresIn: 3 }),
    // cookie 集成插件放在最后，避免 Set-Cookie 被后续插件吞掉
    tanstackStartCookies(),
  ],
  // 开发放宽限流（本地多设备/测试）；生产收紧。
  // enabled 显式置 true：否则 better-auth 默认仅 NODE_ENV=production 时限流，
  // 部署环境漏设 NODE_ENV 时全部规则静默关闭。
  rateLimit: {
    enabled: true,
    ...(process.env.NODE_ENV === 'production'
      ? {
          window: 60,
          max: 20,
          customRules: {
            '/sign-in/email': { window: 60, max: 10 },
            '/sign-up/email': { window: 60, max: 10 },
            '/change-password': { window: 60, max: 5 },
            '/change-email': { window: 60, max: 5 },
            '/sign-in/email-otp': { window: 60, max: 10 },
            '/email-otp/send-verification-otp': { window: 300, max: 3 },
            '/email-otp/verify-email': { window: 60, max: 10 },
            '/email-otp/request-password-reset': { window: 300, max: 3 },
            '/email-otp/reset-password': { window: 60, max: 5 },
          },
        }
      : {
          window: 60,
          max: 100,
          customRules: {
            '/sign-in/email': { window: 60, max: 30 },
            '/sign-up/email': { window: 60, max: 30 },
            '/change-password': { window: 60, max: 10 },
            '/change-email': { window: 60, max: 10 },
            '/sign-in/email-otp': { window: 60, max: 50 },
            '/email-otp/send-verification-otp': { window: 300, max: 30 },
            '/email-otp/verify-email': { window: 60, max: 50 },
            '/email-otp/request-password-reset': { window: 300, max: 30 },
            '/email-otp/reset-password': { window: 60, max: 30 },
          },
        }),
  },
  // 生产强制 Secure cookie：防止 BETTER_AUTH_URL 误配为 http 时
  // 会话 cookie 明文传输（站点应整体部署在 TLS 之后）
  advanced: {
    useSecureCookies: process.env.NODE_ENV === 'production',
  },
  // 本地开发端口不定（vite 自动 +1），显式信任；仅开发环境追加 localhost
  trustedOrigins: [
    authUrl,
    ...(process.env.NODE_ENV !== 'production'
      ? [
          'http://localhost:3000',
          'http://localhost:3001',
          'http://127.0.0.1:3000',
          'http://127.0.0.1:3001',
        ]
      : []),
  ].filter(Boolean),
})

/** WebAuthn Relying Party 配置（passkey） */
export const webauthnConfig = {
  rpName: 'mome',
  rpID: new URL(authUrl).hostname,
  origin: new URL(authUrl).origin,
}
