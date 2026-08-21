import { S3Client } from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { ulid } from '#/lib/ulid'

import { authMiddleware } from './middleware'
import { clientIp, rateLimitOrThrow } from './rate-limit'
import { isAdminUser, loadS3Settings } from './settings-core'

const IMAGE_KINDS = ['avatar', 'memo-image', 'site-icon'] as const

/** 各类型的上传上限（字节），写入预签名 POST 策略强制约束 */
const MAX_BYTES: Record<(typeof IMAGE_KINDS)[number], number> = {
  avatar: 2 * 1024 * 1024,
  'memo-image': 8 * 1024 * 1024,
  'site-icon': 2 * 1024 * 1024,
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
}

export type UploadUrlResult =
  | { mode: 'local' }
  | {
      mode: 'presigned'
      /** 预签名 POST 的目标地址 */
      url: string
      /** 必须随表单一起提交的策略字段 */
      fields: Record<string, string>
      publicUrl: string
      key: string
      maxBytes: number
    }

export const getUploadUrl = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    z.object({
      kind: z.enum(IMAGE_KINDS),
      ext: z.string().min(1).max(10),
    }),
  )
  .handler(async ({ data, context }): Promise<UploadUrlResult> => {
    // 配额：单用户每小时 30 次 + 每日 100 次；全站按 IP 每小时 300 次封顶，
    // 防止开放注册时批量注册账号对 S3 造成存储/流量费用 DoS
    await rateLimitOrThrow(`upload:${context.user.id}`, {
      window: 3600,
      max: 30,
      message: '上传过于频繁，请稍后再试',
    })
    await rateLimitOrThrow(`upload-day:${context.user.id}`, {
      window: 86400,
      max: 100,
      message: '今日上传次数已达上限',
    })
    await rateLimitOrThrow(`upload:global:${clientIp()}`, {
      window: 3600,
      max: 300,
      message: '上传过于频繁，请稍后再试',
    })
    const ext = data.ext.toLowerCase().replace(/^\./, '')
    const mime = EXT_MIME[ext]
    if (!mime) throw new Error('不支持的文件类型')
    if (data.kind === 'site-icon' && !(await isAdminUser(context.user.id))) {
      throw new Error('需要管理员权限')
    }

    const s3 = await loadS3Settings()
    if (!s3.enabled) {
      throw new Error('S3 未配置，图片上传不可用')
    }

    const client = new S3Client({
      endpoint: s3.endpoint,
      region: s3.region,
      credentials: {
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      },
      forcePathStyle: s3.forcePathStyle,
    })
    const key = `mome/${data.kind}/${context.user.id}/${ulid()}.${ext}`
    const maxBytes = MAX_BYTES[data.kind]
    // 预签名 POST：大小 / Content-Type / key 前缀均写入策略，S3 侧强制校验；
    // Content-Disposition: attachment 让对象被直接访问时以下载而非渲染方式返回，
    // 即使客户端伪造 Content-Type 存入 HTML/SVG 类文件也无法在桶域名上执行脚本
    const { url, fields } = await createPresignedPost(client, {
      Bucket: s3.bucket,
      Key: key,
      Expires: 300,
      Conditions: [
        ['content-length-range', 1, maxBytes],
        ['eq', '$Content-Type', mime],
        ['eq', '$Content-Disposition', 'attachment'],
        ['starts-with', '$key', `mome/${data.kind}/${context.user.id}/`],
      ],
      Fields: {
        'Content-Type': mime,
        'Content-Disposition': 'attachment',
      },
    })
    const base = s3.publicUrl || `${s3.endpoint}/${s3.bucket}`
    return {
      mode: 'presigned',
      url,
      fields,
      publicUrl: `${base.replace(/\/$/, '')}/${key}`,
      key,
      maxBytes,
    }
  })
