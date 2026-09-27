import type { Client, Transaction, TransactionMode } from '@libsql/client'

export function serializeTransactions(sourceClient: Client): Client {
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
                try {
                  return await tx.commit()
                } finally {
                  finish()
                }
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
