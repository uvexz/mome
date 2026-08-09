/**
 * 迁移脚本（纯 ESM，仅依赖生产依赖 @libsql/client / drizzle-orm）。
 * 本地：tsx --env-file=.env.local scripts/migrate.mjs
 * Docker：镜像启动时自动执行。
 */
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL 未设置')
  process.exit(1)
}

const client = createClient({
  url,
  authToken: process.env.DATABASE_AUTH_TOKEN,
})
const db = drizzle(client)
const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
)

console.log(`migrating → ${url}`)
await migrate(db, { migrationsFolder })
await client.close?.()
console.log('migration done')
