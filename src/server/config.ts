import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  loadEmailSettings,
  loadSiteSettings,
  loadS3Settings,
} from './settings-core'

export interface AppConfig {
  siteName: string
  siteDescription: string
  siteIcon: string
  allowSignup: boolean
  defaultVisibility: 'public' | 'private'
  emailEnabled: boolean
  emailProvider: 'smtp' | 'resend' | 'console' | 'none'
  s3Enabled: boolean
}

/** 客户端可见的站点信息与功能开关（运行时设置 + 环境变量） */
export const getAppConfig = createServerFn({ method: 'GET' })
  .validator(z.undefined())
  .handler(async (): Promise<AppConfig> => {
    const [site, email, s3] = await Promise.all([
      loadSiteSettings(),
      loadEmailSettings(),
      loadS3Settings(),
    ])
    return {
      siteName: site.name,
      siteDescription: site.description,
      siteIcon: site.icon,
      allowSignup: site.allowSignup,
      defaultVisibility: site.defaultVisibility,
      emailEnabled: email.enabled,
      emailProvider: email.provider,
      s3Enabled: s3.enabled,
    }
  })
