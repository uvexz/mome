/**
 * 依赖 `#/db` 的测试文件共享同一进程与同一个 `#/db` 单例，
 * 因此必须共用同一个临时库路径，并且只在进程退出时清理：
 * 逐个测试文件删除临时库会让后运行的测试文件拿到已被 unlink 的连接
 * （SQLITE_READONLY_DBMOVED）。
 */
import { unlinkSync } from 'node:fs'

export const TEST_DB_PATH = `/private/tmp/mome-test-${process.pid}.db`

export function useTestDatabase(): void {
  process.env.DATABASE_URL ??= `file:${TEST_DB_PATH}`
  process.on('exit', () => {
    for (const suffix of ['', '-shm', '-wal']) {
      try {
        unlinkSync(`${TEST_DB_PATH}${suffix}`)
      } catch {
        // 文件不存在或已被清理
      }
    }
  })
}
