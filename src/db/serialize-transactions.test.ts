import { describe, expect, test } from 'bun:test'
import type { Client, Transaction } from '@libsql/client'

import { serializeTransactions } from './serialize-transactions'

describe('serializeTransactions', () => {
  test('releases the queue after a commit failure', async () => {
    let transactionCount = 0
    let secondTransactionStarted = false
    const source = {
      transaction: async () => {
        transactionCount++
        if (transactionCount === 2) secondTransactionStarted = true
        return {
          commit: async () => {
            if (transactionCount === 1) throw new Error('commit failed')
          },
          rollback: async () => undefined,
          close: () => undefined,
        } as unknown as Transaction
      },
    } as unknown as Client
    const client = serializeTransactions(source)
    const first = await client.transaction()
    const secondPromise = client.transaction()

    await expect(first.commit()).rejects.toThrow('commit failed')
    const second = await secondPromise
    expect(secondTransactionStarted).toBe(true)
    await second.commit()
  })
})
