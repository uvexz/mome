import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'

import * as schema from './schema.ts'

const client = createClient({
  url: process.env.DATABASE_URL!, // file:./local.db | libsql://xxx.turso.io
  authToken: process.env.DATABASE_AUTH_TOKEN, // 仅远端需要
})

export const db = drizzle(client, { schema })
