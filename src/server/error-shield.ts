/**
 * server function 全局错误隔离。
 *
 * - `AppError`：有意的业务错误，message 面向用户，可原样序列化到客户端；
 * - `errorShield`：挂在 src/start.ts 的全局 functionMiddleware 上，
 *   把意外错误（drizzle 约束冲突、SDK 异常等）降级为通用文案并记录服务端日志，
 *   防止内部细节泄漏给前端。redirect / 非 Error 控制流对象原样放行。
 *
 * 本模块会被打进客户端包（start.ts 双端加载），禁止引入服务端专属依赖。
 */
import { createMiddleware } from '@tanstack/react-start'
import { isRedirect } from '@tanstack/react-router'

export class AppError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppError'
  }
}

const GENERIC_ERROR_MESSAGE = '服务器开小差了，请稍后重试'

export const errorShield = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    try {
      return await next()
    } catch (error) {
      if (isRedirect(error)) throw error
      if (!(error instanceof Error)) throw error
      if (error instanceof AppError) throw error
      console.error('[server-fn] unexpected error:', error)
      throw new AppError(GENERIC_ERROR_MESSAGE)
    }
  },
)
