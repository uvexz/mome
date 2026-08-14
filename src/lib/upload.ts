/**
 * 客户端上传辅助：与服务端预签名 POST（S3 POST policy）匹配。
 * 预签名 URL / fields / maxBytes 来自 server function getUploadUrl。
 */

export interface PresignedPost {
  url: string
  fields: Record<string, string>
  maxBytes: number
}

/** 图片魔数（magic bytes）签名：声称的扩展名必须与文件真实字节一致 */
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

/**
 * 校验文件头魔数与扩展名一致。
 * S3 预签名策略只校验客户端自报的 Content-Type 字符串，不校验文件字节，
 * 因此上传前必须在此拦截"改名上传"（如把 HTML/SVG 伪装成 png）。
 */
export async function assertImageSignature(
  file: Blob,
  ext: string,
): Promise<void> {
  const checks = SIGNATURES[ext.toLowerCase()]
  if (!checks) throw new Error('不支持的文件类型')
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const matched = checks.every(({ offset, bytes }) =>
    bytes.every((byte, i) => head[offset + i] === byte),
  )
  if (!matched) {
    throw new Error('文件内容与图片类型不符')
  }
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
