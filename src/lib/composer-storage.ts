export interface ComposerDraft {
  content: string
  visibility: 'public' | 'private'
  updatedAt: number
}

export interface QueuedMemo {
  id: string
  content: string
  visibility: 'public' | 'private'
  createdAt: number
  /** 在线重发失败次数；超过上限的"毒丸"条目会被丢弃而非无限重试 */
  attempts?: number
}

const DB_NAME = 'mome-client'
const DB_VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts')
      }
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function loadComposerDraft(
  key: string,
): Promise<ComposerDraft | null> {
  const db = await openDb()
  try {
    const transaction = db.transaction('drafts', 'readonly')
    return (
      (await requestResult(transaction.objectStore('drafts').get(key))) ?? null
    )
  } finally {
    db.close()
  }
}

export async function saveComposerDraft(
  key: string,
  draft: ComposerDraft,
): Promise<void> {
  const db = await openDb()
  try {
    const transaction = db.transaction('drafts', 'readwrite')
    await requestResult(transaction.objectStore('drafts').put(draft, key))
  } finally {
    db.close()
  }
}

export async function clearComposerDraft(key: string): Promise<void> {
  const db = await openDb()
  try {
    const transaction = db.transaction('drafts', 'readwrite')
    await requestResult(transaction.objectStore('drafts').delete(key))
  } finally {
    db.close()
  }
}

export async function enqueueMemo(item: QueuedMemo): Promise<void> {
  const db = await openDb()
  try {
    const transaction = db.transaction('outbox', 'readwrite')
    await requestResult(transaction.objectStore('outbox').put(item))
  } finally {
    db.close()
  }
}

export async function listQueuedMemos(): Promise<QueuedMemo[]> {
  const db = await openDb()
  try {
    const transaction = db.transaction('outbox', 'readonly')
    const items = await requestResult(
      transaction.objectStore('outbox').getAll() as IDBRequest<QueuedMemo[]>,
    )
    return items.sort((a, b) => a.createdAt - b.createdAt)
  } finally {
    db.close()
  }
}

export async function removeQueuedMemo(id: string): Promise<void> {
  const db = await openDb()
  try {
    const transaction = db.transaction('outbox', 'readwrite')
    await requestResult(transaction.objectStore('outbox').delete(id))
  } finally {
    db.close()
  }
}

/** 在线重发失败后累加计数，返回最新次数 */
export async function incrementQueuedMemoAttempts(id: string): Promise<number> {
  const db = await openDb()
  try {
    const transaction = db.transaction('outbox', 'readwrite')
    const store = transaction.objectStore('outbox')
    const item = (await requestResult(store.get(id))) as QueuedMemo | undefined
    if (!item) return 0
    const attempts = (item.attempts ?? 0) + 1
    await requestResult(store.put({ ...item, attempts }))
    return attempts
  } finally {
    db.close()
  }
}
