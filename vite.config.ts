import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const isProd = process.env.NODE_ENV === 'production'

// 生产环境附加强化头；CSP/HSTS 仅生产启用
const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}
if (isProd) {
  securityHeaders['Strict-Transport-Security'] = 'max-age=31536000'
  securityHeaders['Content-Security-Policy'] = [
    "default-src 'self'",
    // TanStack Start 依赖内联脚本完成 hydration($tsr-stream-barrier 流式注入 + 滚动恢复)，
    // router-core 的注入 transform 不支持 nonce，且 payload 为动态内容无法 hash，必须放行 unsafe-inline
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data:",
    "font-src 'self' data:",
    // 需允许直连任意 https：S3 端点为运行时配置；浏览器端无其他第三方调用
    "connect-src 'self' https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    nitro({
      rollupConfig: { external: [/^@sentry\//] },
      routeRules: { '/**': { headers: securityHeaders } },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
