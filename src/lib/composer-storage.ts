export interface ComposerDraft {
  content: string
  visibility: 'public' | 'private'
  updatedAt: number
}

export interface QueuedMemo {
  id: string
  /**
   * 入队时已登录的用户 ID。缺失表示旧版本写入的条目：这些条目不属于任何已知
   * 作者，只能隔离等待人工恢复，绝不能自动归属到"下一位登录者"。
   */
  userId?: string
  content: string
  visibility: 'public' | 'private'
  createdAt: number
  /** 在线重发失败次数；超过上限后停止重试，但保留内容 */
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

export async function enqueueMemo(
  item: QueuedMemo & { userId: string },
): Promise<void> {
  const db = await openDb()
  try {
    const transaction = db.transaction('outbox', 'readwrite')
    await requestResult(transaction.objectStore('outbox').put(item))
  } finally {
    db.close()
  }
}

async function allQueuedMemos(): Promise<QueuedMemo[]> {
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

/** 只返回指定作者的待发送条目：共享浏览器切换账号后不能替别人重发 */
export async function listQueuedMemos(userId: string): Promise<QueuedMemo[]> {
  return (await allQueuedMemos()).filter((item) => item.userId === userId)
}

/** 无作者（旧版本）或属于其他账号的条目数量，仅用于提示人工恢复 */
export async function countUnclaimedQueuedMemos(
  userId: string,
): Promise<number> {
  return (await allQueuedMemos()).filter((item) => item.userId !== userId)
    .length
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
