/**
 * Memos 兼容层的附件端点：把上游的 attachments 资源桥接到 Mome 的图片上传逻辑。
 *
 * Mome 没有附件表——图片按原生流程直接进 S3，正文里以 Markdown 链接呈现。
 * 这里不新增存储：key 布局 / 公开 URL / 配额复用 `#/server/s3` 与原生上传同一口径，
 * 类型判定复用 `#/lib/upload` 的文件头魔数。
 *
 * 返回给客户端的资源名 `attachments/{token}` 是对象 key 的 base64url 封装，
 * 创建 memo 时解回并校验归属——CreateMemo 引用附件因此不需要服务端状态。
 */
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

import { IMAGE_MIME_BY_EXT, resolveImageUpload } from '#/lib/upload'

import { clientIp, rateLimitOrThrow } from '../rate-limit'
import {
  MEMO_IMAGE_MAX_BYTES,
  createS3Client,
  s3ObjectPublicUrl,
  uploadObjectKey,
} from '../s3'
import { loadS3Settings } from '../settings-core'
import { ATTACHMENT_PREFIX } from './dto'
import { protoTimestamp } from './json'
import { Code, MemosError } from './errors'

/** 单条 memo 可引用的附件数上限：web-clipper 一次最多上传 10 张图片 */
const MAX_ATTACHMENTS_PER_MEMO = 10

const MAX_FILENAME_LENGTH = 255

/** 对象 key 形状：`mome/memo-image/{userId}/{ulid}.{ext}`，尾段不含 `/` 与 `.`（除扩展名分隔） */
const OBJECT_KEY_PATTERN =
  /^mome\/memo-image\/([^/]+)\/([0-9A-Za-z]{1,64}\.[a-z0-9]{1,10})$/

/**
 * 与原生上传同一配额：单用户每小时 30 次 / 每日 100 次，全站按 IP 每小时 300 次。
 * 需在解析 base64 正文之前调用，被限流的请求不进入 MB 级解析。
 */
export async function assertAttachmentQuota(userId: string): Promise<void> {
  const checks: Array<{
    key: string
    window: number
    max: number
    message: string
  }> = [
    {
      key: `upload:${userId}`,
      window: 3600,
      max: 30,
      message: '上传过于频繁，请稍后再试',
    },
    {
      key: `upload-day:${userId}`,
      window: 86400,
      max: 100,
      message: '今日上传次数已达上限',
    },
    {
      key: `upload:global:${clientIp()}`,
      window: 3600,
      max: 300,
      message: '上传过于频繁，请稍后再试',
    },
  ]
  for (const check of checks) {
    try {
      await rateLimitOrThrow(check.key, {
        window: check.window,
        max: check.max,
        message: check.message,
      })
    } catch {
      throw new MemosError(Code.RESOURCE_EXHAUSTED, check.message)
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MemosError(Code.INVALID_ARGUMENT, `${field} 不能为空`)
  }
  return value
}

/** base64（标准或 URL-safe，允许换行）→ 字节；大小上限在解析前拦下 */
function decodeContent(value: unknown): Uint8Array<ArrayBuffer> {
  const normalized = requireString(value, 'content')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      'content 必须是 base64 编码的图片字节',
    )
  }
  // 复制进新的 ArrayBuffer：Buffer 的 ArrayBufferLike 不能直接当 BlobPart
  const bytes = new Uint8Array(Buffer.from(normalized, 'base64'))
  if (bytes.byteLength === 0) {
    throw new MemosError(Code.INVALID_ARGUMENT, 'content 不能为空')
  }
  if (bytes.byteLength > MEMO_IMAGE_MAX_BYTES) {
    const mb = Math.round(MEMO_IMAGE_MAX_BYTES / 1024 / 1024)
    throw new MemosError(Code.INVALID_ARGUMENT, `图片不能超过 ${mb}MB`)
  }
  return bytes
}

/** 文件名与声明类型只是线索，真实类型以文件头魔数为准（与编辑器粘贴上传同一判定） */
async function resolveImage(
  filename: string,
  type: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<{ ext: string; mime: string }> {
  try {
    return await resolveImageUpload(new File([bytes], filename, { type }))
  } catch (error) {
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      error instanceof Error
        ? error.message
        : '文件内容不是受支持的图片（支持 PNG / JPEG / GIF / WebP / AVIF）',
    )
  }
}

function attachmentResourceName(key: string): string {
  return `${ATTACHMENT_PREFIX}/${Buffer.from(key, 'utf8').toString('base64url')}`
}

/**
 * 附件 id（资源名的尾段）→ 对象 key。
 *
 * 两个入口共用同一套校验：CreateMemo 传完整资源名 `attachments/{id}`，
 * DeleteAttachment 的路径参数是**裸 id**（客户端取 `attachments/{id}` 的最后一段）。
 * 形状不合法按 INVALID_ARGUMENT，非本人按 PERMISSION_DENIED。
 */
function attachmentObjectKeyFromToken(actorId: string, token: unknown): string {
  if (typeof token !== 'string' || !token || token.includes('/')) {
    throw new MemosError(Code.INVALID_ARGUMENT, 'attachment id 不合法')
  }
  const key = Buffer.from(token, 'base64url').toString('utf8')
  const match = OBJECT_KEY_PATTERN.exec(key)
  if (!match) {
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      'attachment id 不是有效的附件资源名',
    )
  }
  if (match[1] !== actorId) {
    throw new MemosError(Code.PERMISSION_DENIED, '只能操作自己上传的附件')
  }
  const ext = match[2].split('.').pop() ?? ''
  if (!IMAGE_MIME_BY_EXT[ext]) {
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      'attachment id 的文件类型不受支持',
    )
  }
  return key
}

/** `attachments/{token}` 资源名 → 对象 key */
function attachmentObjectKey(actorId: string, name: unknown): string {
  if (typeof name !== 'string' || !name.startsWith(`${ATTACHMENT_PREFIX}/`)) {
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      'attachment.name 必须是附件上传返回的 attachments/{id}',
    )
  }
  return attachmentObjectKeyFromToken(
    actorId,
    name.slice(ATTACHMENT_PREFIX.length + 1),
  )
}

/**
 * 上传一张图片并返回上游 CreateAttachment 形态。
 * 与原生预签名上传共用 key 布局、Content-Disposition 与公开 URL 规则，
 * 区别只是字节由服务端代传（兼容层拿到的是 JSON 里的 base64）。
 */
export async function createAttachmentForUser(
  actorId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const attachment = (body.attachment ?? body) as Record<string, unknown>
  const filename = requireString(attachment.filename, 'filename')
  if (filename.length > MAX_FILENAME_LENGTH) {
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      `filename 不能超过 ${MAX_FILENAME_LENGTH} 个字符`,
    )
  }
  const type = requireString(attachment.type, 'type')
  const bytes = decodeContent(attachment.content)
  const { ext, mime } = await resolveImage(filename, type, bytes)

  const s3 = await loadS3Settings()
  if (!s3.enabled) {
    throw new MemosError(Code.FAILED_PRECONDITION, 'S3 未配置，图片上传不可用')
  }

  const key = uploadObjectKey('memo-image', actorId, ext)
  try {
    await createS3Client(s3).send(
      new PutObjectCommand({
        Bucket: s3.bucket,
        Key: key,
        Body: bytes,
        ContentType: mime,
        ContentDisposition: 'attachment',
      }),
    )
  } catch (error) {
    console.error('[memos-compat] attachment upload failed', error)
    throw new MemosError(Code.UNAVAILABLE, '图片上传失败，请稍后重试')
  }

  return {
    name: attachmentResourceName(key),
    createTime: protoTimestamp(new Date()),
    filename,
    type: mime,
    size: String(bytes.byteLength),
    // 客户端取图优先用 externalLink：没有它就会回退拼
    // `{host}/file/{name}/{filename}`，而 Mome 不提供该路由，附件只能 404。
    // 这里直接给对象公开地址，与正文里落下的 Markdown 图片是同一个 URL。
    externalLink: s3ObjectPublicUrl(s3, key),
  }
}

/**
 * 删除一张附件对应的 S3 对象。
 *
 * Mome 没有附件表，对象 key 就是唯一事实来源：资源名解出的 key 通过形状与归属
 * 校验后即可删。S3 未配置时该附件根本不可能存在（上传会先失败），因此与上传
 * 同口径返回 FAILED_PRECONDITION，而不是伪装成删除成功。
 *
 * S3 的 DeleteObject 本身幂等：对象已被删掉时仍返回成功，重复调用是安全的。
 */
export async function deleteAttachmentForUser(
  actorId: string,
  token: unknown,
): Promise<void> {
  const key = attachmentObjectKeyFromToken(actorId, token)
  const s3 = await loadS3Settings()
  if (!s3.enabled) {
    throw new MemosError(Code.FAILED_PRECONDITION, 'S3 未配置，附件删除不可用')
  }
  try {
    await createS3Client(s3).send(
      new DeleteObjectCommand({ Bucket: s3.bucket, Key: key }),
    )
  } catch (error) {
    console.error('[memos-compat] attachment delete failed', error)
    throw new MemosError(Code.UNAVAILABLE, '附件删除失败，请稍后重试')
  }
}

/**
 * 把 CreateMemo 里的 `attachments: [{name}]` 解析成正文末尾的 Markdown 图片。
 * 正文是 Mome 承载图片的唯一载体（没有附件表），所以引用即写入正文。
 */
export async function attachmentImageMarkdown(
  actorId: string,
  attachments: unknown,
): Promise<string[]> {
  if (attachments === undefined || attachments === null) return []
  if (!Array.isArray(attachments)) {
    throw new MemosError(Code.INVALID_ARGUMENT, 'attachments 必须是数组')
  }
  if (attachments.length === 0) return []
  if (attachments.length > MAX_ATTACHMENTS_PER_MEMO) {
    throw new MemosError(
      Code.INVALID_ARGUMENT,
      `一条 memo 最多引用 ${MAX_ATTACHMENTS_PER_MEMO} 个附件`,
    )
  }
  const keys = attachments.map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw new MemosError(
        Code.INVALID_ARGUMENT,
        'attachments 的每一项必须是 {name}',
      )
    }
    return attachmentObjectKey(actorId, (item as Record<string, unknown>).name)
  })

  const s3 = await loadS3Settings()
  if (!s3.enabled) {
    throw new MemosError(Code.FAILED_PRECONDITION, 'S3 未配置，无法引用附件')
  }
  return keys.map((key) => `![image](${s3ObjectPublicUrl(s3, key)})`)
}
