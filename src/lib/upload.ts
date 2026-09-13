/**
 * 客户端上传辅助：与服务端预签名 POST（S3 POST policy）匹配。
 * 预签名 URL / fields / maxBytes 来自 server function getUploadUrl。
 */

export interface PresignedPost {
  url: string
  fields: Record<string, string>
  maxBytes: number
}

/** 可上传图片类型：扩展名 → MIME（服务端预签名策略按同一映射断言 Content-Type） */
export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
}

/**
 * 图片魔数（magic bytes）签名：声称的扩展名必须与文件真实字节一致。
 * 用 Partial 表达"查不到即未知类型"，调用方必须显式处理未收录的扩展名。
 */
const SIGNATURES: Partial<
  Record<string, Array<{ offset: number; bytes: number[] }>>
> = {
  png: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  jpg: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  jpeg: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  gif: [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }],
  webp: [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  ],
  avif: [
    { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
    { offset: 8, bytes: [0x61, 0x76] },
  ],
}

const MIME_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(IMAGE_MIME_BY_EXT).map(([ext, mime]) => [mime, ext]),
)

/** 取扩展名；dataTransfer 里粘贴的文件名常常没有点号（blob、image） */
function extFromName(name: string | undefined): string | null {
  const match = /\.([a-z0-9]+)$/i.exec((name ?? '').trim())
  return match ? match[1].toLowerCase() : null
}

function extFromMime(mime: string | undefined): string | null {
  const value = (mime ?? '').trim().toLowerCase()
  return value.startsWith('image/') ? (MIME_EXT[value] ?? null) : null
}

/** 文件头 16 字节足够覆盖全部签名（最深的检查在 offset 8） */
function readHead(file: Blob): Promise<Uint8Array> {
  return file
    .slice(0, 16)
    .arrayBuffer()
    .then((buf) => new Uint8Array(buf))
}

/**
 * 文件头签名比对。`head` 是文件头 16 字节（比文件短时更少），
 * 越界一律视为不匹配——短文件不会因为读不到字节而被误判成图片。
 */
function matchesSignature(head: Uint8Array, ext: string): boolean {
  const checks = SIGNATURES[ext]
  if (!checks) return false
  return checks.every(({ offset, bytes }) =>
    bytes.every((byte, i) => {
      const index = offset + i
      // 先做边界判断：读不到字节（短文件）一律不匹配
      return index < head.length && head[index] === byte
    }),
  )
}

/** 按文件头魔数判断真实图片类型 */
function sniffExt(head: Uint8Array): string | null {
  for (const ext of Object.keys(SIGNATURES)) {
    if (matchesSignature(head, ext)) return ext
  }
  return null
}

export interface ResolvedImage {
  ext: string
  mime: string
}

/**
 * 从粘贴 / 选择的文件里定出扩展名与 MIME，二者始终来自同一映射，
 * 因此服务端策略里的 `eq $Content-Type` 断言不会被自报类型绕过。
 *
 * 文件名与声明类型都只是线索：剪贴板图片常出现 image.png 却是 JPEG 字节，
 * 命名与内容不符时一律以文件头魔数为准（退回真实类型而不是拒绝）。
 * S3 预签名策略不校验文件字节，字节层面的把关只能在这里做。
 */
export async function resolveImageUpload(file: {
  name?: string
  type?: string
}): Promise<ResolvedImage> {
  const ext = extFromMime(file.type) ?? extFromName(file.name)
  // `file` 本身是 Blob，直接读文件头，不额外缓存字节
  const head = await readHead(file as Blob)
  if (ext && IMAGE_MIME_BY_EXT[ext] && matchesSignature(head, ext)) {
    return { ext, mime: IMAGE_MIME_BY_EXT[ext] }
  }
  const sniffed = sniffExt(head)
  if (sniffed) return { ext: sniffed, mime: IMAGE_MIME_BY_EXT[sniffed] }
  throw new Error(
    '文件内容不是受支持的图片（支持 PNG / JPEG / GIF / WebP / AVIF）',
  )
}

/** 以 multipart/form-data POST 上传文件（字段顺序无碍，file 放最后） */
export async function uploadPresignedPost(
  presigned: PresignedPost,
  file: Blob,
): Promise<void> {
  if (file.size > presigned.maxBytes) {
    const mb = Math.round(presigned.maxBytes / 1024 / 1024)
    throw new Error(`图片过大，上限为 ${mb}MB`)
  }
  const form = new FormData()
  for (const [key, value] of Object.entries(presigned.fields)) {
    form.append(key, value)
  }
  form.append('file', file)
  const res = await fetch(presigned.url, { method: 'POST', body: form })
  if (!res.ok) {
    throw new Error(`上传失败（HTTP ${res.status}）`)
  }
}
