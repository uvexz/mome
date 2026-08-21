import '@tanstack/react-start/server-only'

import { createClient } from '@libsql/client'
import type { Client, Transaction, TransactionMode } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'

import * as schema from './schema.ts'

const baseClient = createClient({
  url: process.env.DATABASE_URL!, // file:./local.db | libsql://xxx.turso.io
  authToken: process.env.DATABASE_AUTH_TOKEN, // 仅远端需要
  timeout: process.env.DATABASE_URL?.startsWith('file:') ? 5_000 : undefined,
})
const client = process.env.DATABASE_URL?.startsWith('file:')
  ? serializeTransactions(baseClient)
  : baseClient

export const db = drizzle(client, { schema })

function serializeTransactions(sourceClient: Client): Client {
  // libSQL's local client opens a new connection per interactive transaction;
  // serialize those writes so one process cannot deadlock itself on SQLite.
  let tail = Promise.resolve()
  return new Proxy(sourceClient, {
    get(target, property) {
      if (property !== 'transaction') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async (mode?: TransactionMode): Promise<Transaction> => {
        let release!: () => void
        const current = new Promise<void>((resolve) => {
          release = resolve
        })
        const previous = tail
        tail = previous.then(() => current)
        await previous
        let transaction: Transaction
        try {
          transaction = await target.transaction(mode)
        } catch (error) {
          release()
          throw error
        }
        let released = false
        const finish = () => {
          if (released) return
          released = true
          release()
        }
        return new Proxy(transaction, {
          get(tx, txProperty) {
            if (txProperty === 'commit') {
              return async () => {
                const result = await tx.commit()
                finish()
                return result
              }
            }
            if (txProperty === 'rollback') {
              return async () => {
                try {
                  return await tx.rollback()
                } finally {
                  finish()
                }
              }
            }
            if (txProperty === 'close') {
              return () => {
                try {
                  return tx.close()
                } finally {
                  finish()
                }
              }
            }
            const value = Reflect.get(tx, txProperty, tx)
            return typeof value === 'function' ? value.bind(tx) : value
          },
        })
      }
    },
  })
}
