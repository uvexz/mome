import '@tanstack/react-start/server-only'

import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'

import * as schema from './schema.ts'
import { serializeTransactions } from './serialize-transactions.ts'

const baseClient = createClient({
  url: process.env.DATABASE_URL!, // file:./local.db | libsql://xxx.turso.io
  authToken: process.env.DATABASE_AUTH_TOKEN, // 仅远端需要
  timeout: process.env.DATABASE_URL?.startsWith('file:') ? 5_000 : undefined,
})
const client = process.env.DATABASE_URL?.startsWith('file:')
  ? serializeTransactions(baseClient)
  : baseClient

export const db = drizzle(client, { schema })
