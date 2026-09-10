/**
 * 依赖 `#/db` 的测试文件共享同一进程与同一个 `#/db` 单例，
 * 因此必须共用同一个临时库路径，并且只在进程退出时清理：
 * 逐个测试文件删除临时库会让后运行的测试文件拿到已被 unlink 的连接
 * （SQLITE_READONLY_DBMOVED）。
 *
 * 路径由 `mkdtemp` 在系统临时目录下生成：既跨平台（旧版本硬编码 macOS 的
 * `/private/tmp`，Linux 上直接失败），也保证测试永远不会连到环境里已有的
 * `DATABASE_URL` 并对它执行 migration 和写入。需要指定外部测试库时，用专门的
 * `MOME_TEST_DATABASE_URL`，普通的 `DATABASE_URL` 一律忽略。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_DB_DIR = mkdtempSync(join(tmpdir(), 'mome-test-'))

export const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db')

export function useTestDatabase(): void {
  const external = process.env.MOME_TEST_DATABASE_URL
  if (external) {
    process.env.DATABASE_URL = external
    return
  }
  process.env.DATABASE_URL = `file:${TEST_DB_PATH}`
  process.on('exit', () => {
    try {
      rmSync(TEST_DB_DIR, { recursive: true, force: true })
    } catch {
      // 目录不存在或已被清理
    }
  })
}
