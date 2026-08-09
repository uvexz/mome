/**
 * 客户端上传辅助：与服务端预签名 POST（S3 POST policy）匹配。
 * 预签名 URL / fields / maxBytes 来自 server function getUploadUrl。
 */

export interface PresignedPost {
  url: string
  fields: Record<string, string>
  maxBytes: number
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
