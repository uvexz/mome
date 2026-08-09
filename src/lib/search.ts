import { z } from 'zod'

/** 首页 search params：?tag= ?q= ?filter= */
export const homeSearchSchema = z.object({
  tag: z.string().optional(),
  q: z.string().max(200).optional(),
  filter: z.enum(['all', 'archived']).optional(),
})

export type HomeSearch = z.infer<typeof homeSearchSchema>

/** 转义 SQL LIKE 通配符（配合 ESCAPE '\' 使用） */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}
