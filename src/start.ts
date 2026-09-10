import { createCsrfMiddleware, createStart } from '@tanstack/react-start'

import { errorShield } from './server/error-shield'

// Server Function 全部走 cookie 鉴权，必须校验可信来源；
// Bearer-only 的 /v1 与兼容 API 不经过这里，各自维持自己的策略。
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === 'serverFn',
})

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
  functionMiddleware: [errorShield],
}))
