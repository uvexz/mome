import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

config({ path: ['.env.local', '.env'] })

const url = process.env.DATABASE_URL!

// 按 URL 前缀动态选择 dialect：本地 file: 用 sqlite，远端 libsql:// 用 turso
const isRemote = url.startsWith('libsql://')

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: isRemote ? 'turso' : 'sqlite',
  dbCredentials: {
    url,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
})
