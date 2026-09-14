/**
 * S3 对象存储的公共管道。
 *
 * 客户端预签名上传（`getUploadUrl`）与 Memos 兼容层的附件上传
 * （`POST /api/v1/attachments`）共用同一套 key 布局、公开 URL 规则与客户端配置，
 * 两条路径分头拼字符串迟早会漂移。
 */
import { S3Client } from '@aws-sdk/client-s3'

import { ulid } from '#/lib/ulid'
import type { S3RuntimeSettings } from './settings-core'

/** memo 正文图片上限（字节）：写入预签名策略，兼容层按同一口径校验 base64 载荷 */
export const MEMO_IMAGE_MAX_BYTES = 8 * 1024 * 1024

export function createS3Client(s3: S3RuntimeSettings): S3Client {
  return new S3Client({
    endpoint: s3.endpoint,
    region: s3.region,
    credentials: {
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
    },
    forcePathStyle: s3.forcePathStyle,
  })
}

/** 对象 key：前缀参与预签名策略的 starts-with 断言，写入与读取必须是同一形状 */
export function uploadObjectKey(
  kind: string,
  userId: string,
  ext: string,
): string {
  return `mome/${kind}/${userId}/${ulid()}.${ext}`
}

/** 对象公开访问地址：未配置 CDN 域名时回落到 endpoint/bucket */
export function s3ObjectPublicUrl(
  s3: Pick<S3RuntimeSettings, 'publicUrl' | 'endpoint' | 'bucket'>,
  key: string,
): string {
  const base = s3.publicUrl || `${s3.endpoint}/${s3.bucket}`
  return `${base.replace(/\/$/, '')}/${key}`
}
