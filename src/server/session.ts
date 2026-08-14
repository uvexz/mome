import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { getSessionUserFromRequest } from './session-core'

/** 获取当前会话用户；未登录返回 null（用于路由守卫，不抛重定向） */
export const getSessionUser = createServerFn({ method: 'GET' })
  .validator(z.undefined())
  .handler(async () => getSessionUserFromRequest())
