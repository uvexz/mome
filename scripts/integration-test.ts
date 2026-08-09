/**
 * 集成测试：直接调用 memos-core / tags-core（真实 DB 读写）。
 * 需要 .env.local 与已迁移的 local.db。
 *
 *   bunx tsx --env-file=.env.local scripts/integration-test.ts
 */
import { config } from 'dotenv'
import { auth } from '../src/lib/auth'
import {
  createMemoForUser,
  deleteMemoForUser,
  exportMemosForUser,
  getContributionForUser,
  getStatsForUser,
  importMemosForUser,
  listMemosForUser,
  setVisibilityForUser,
  toggleArchiveForUser,
  toggleGlobalPinForAdmin,
  togglePinForUser,
  updateMemoForUser,
} from '../src/server/memos-core'
import {
  addCommentForUser,
  deleteCommentForUser,
  listCommentsForMemo,
  toggleFavoriteForUser,
  toggleLikeForUser,
  toggleRepostForUser,
  updateRepostForUser,
} from '../src/server/interactions-core'
import {
  getPublicMemoDetail,
  getPublicProfileByUsername,
  listAllPublicMemos,
  listPublicFeed,
} from '../src/server/public-core'
import {
  listHomeFeedForUser,
  listInteractionsForUser,
} from '../src/server/timeline-core'
import { listTagsForUser } from '../src/server/tags-core'
import {
  authenticateApiKeyToken,
  createApiKeyForUser,
  listApiKeysForUser,
  revokeApiKeyForUser,
} from '../src/server/api-keys-core'

config({ path: ['.env.local', '.env'] })

let passed = 0
let failed = 0
function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}

async function main() {
  const email = `it-${Date.now()}@mome.dev`
  const password = 'integration-pass-123'
  const username = `it${Date.now().toString().slice(-8)}`

  console.log('→ 注册用户', email)
  const signUpRes = await auth.api.signUpEmail({
    body: { name: '集成测试', username, email, password },
    headers: new Headers(),
  })
  const userId = signUpRes.user.id
  assert(Boolean(userId), '注册成功')
  assert(signUpRes.user.username === username, '注册返回用户名')

  const memoId1 = (
    await createMemoForUser(userId, '今天学习 #rust/ownership 和 #rust 借用')
  ).id
  assert(Boolean(memoId1), 'createMemo 返回 id')

  const memoId2 = (await createMemoForUser(userId, '记录 #生活 的碎片')).id
  assert(Boolean(memoId2), 'createMemo 第二条')

  // 可见性：默认私密 → 设为公开
  assert(
    (await listMemosForUser(userId, { limit: 10 })).items[0]?.visibility ===
      'private',
    '新 memo 默认私密',
  )
  const vis = await setVisibilityForUser(userId, memoId1, 'public')
  assert(vis.visibility === 'public', 'setVisibility 设为公开')

  // listMemos
  const page = await listMemosForUser(userId, { limit: 10 })
  assert(page.items.length === 2, `listMemos 返回 ${page.items.length} 条`)
  const m1 = page.items.find((i) => i.id === memoId1)
  assert(
    m1?.tags.some((t) => t.name === 'ownership'),
    '标签同步：memo 关联了 #rust/ownership 叶子标签',
  )
  assert(
    page.items[0]?.id === memoId2 && page.items[1]?.id === memoId1,
    '时间线倒序（新在前）',
  )

  // tag 筛选（父标签命中子标签 memo）
  const byTag = await listMemosForUser(userId, { tag: 'rust', limit: 10 })
  assert(byTag.items.length === 1, '按父标签 #rust 筛选命中 1 条')

  const bySubTag = await listMemosForUser(userId, {
    tag: 'rust/ownership',
    limit: 10,
  })
  assert(bySubTag.items.length === 1, '按子标签 #rust/ownership 筛选命中 1 条')

  // 搜索
  const byQ = await listMemosForUser(userId, { q: '碎片', limit: 10 })
  assert(
    byQ.items.length === 1 && byQ.items[0]?.content.includes('碎片'),
    '搜索命中内容',
  )

  // updateMemo（改标签）
  const updated = await updateMemoForUser(userId, memoId1, '更新后 #work 内容')
  assert(
    updated.tags.some((t) => t.name === 'work'),
    'updateMemo 重新同步标签',
  )

  // togglePin
  const pin = await togglePinForUser(userId, memoId2)
  assert(pin.pinned === true, 'togglePin 置顶成功')
  const pinnedList = await listMemosForUser(userId, { limit: 10 })
  assert(pinnedList.items[0]?.id === memoId2, '置顶 memo 排在首位')
  await togglePinForUser(userId, memoId1)
  const replacedPinList = await listMemosForUser(userId, { limit: 10 })
  assert(
    replacedPinList.items[0]?.id === memoId1 &&
      replacedPinList.items.filter((memo) => memo.pinned).length === 1 &&
      replacedPinList.items.find((memo) => memo.id === memoId2)?.pinned ===
        false,
    '新置顶替换旧置顶，同一用户只有一条置顶 memo',
  )

  // toggleArchive
  const arc = await toggleArchiveForUser(userId, memoId2)
  assert(arc.archived === true, 'toggleArchive 归档成功')
  const normal = await listMemosForUser(userId, { limit: 10 })
  assert(normal.items.length === 1, '归档后默认视图只剩 1 条')
  const archived = await listMemosForUser(userId, {
    filter: 'archived',
    limit: 10,
  })
  assert(archived.items.length === 1, '归档视图返回归档 memo')

  // listTags
  const tags = await listTagsForUser(userId)
  assert(
    tags.some((t) => t.name === 'work' && t.count === 1),
    'listTags 返回标签及计数',
  )

  // getStats
  const stats = await getStatsForUser(userId)
  assert(stats.total === 1, '统计：未归档 1 条')

  // API keys
  const apiKey = await createApiKeyForUser(userId, '集成测试 key')
  assert(apiKey.token.startsWith('mome_'), 'API key 带 mome_ 前缀')
  const apiUser = await authenticateApiKeyToken(apiKey.token)
  assert(apiUser?.id === userId, 'API key 可解析到用户')
  const apiKeys = await listApiKeysForUser(userId)
  assert(
    apiKeys.length === 1 && apiKeys[0]?.name === '集成测试 key',
    '列表返回新 key',
  )
  await revokeApiKeyForUser(userId, apiKey.key.id)
  assert(
    (await authenticateApiKeyToken(apiKey.token)) === null,
    '撤销后 API key 失效',
  )
  const contribution = await getContributionForUser(userId)
  assert(
    contribution.month === contribution.maxMonth &&
      contribution.total === 1 &&
      contribution.days.length >= 28 &&
      contribution.days.length <= 31 &&
      contribution.minMonth <= contribution.maxMonth,
    '贡献图：默认当月数据、计数与月份范围正确',
  )

  // deleteMemo
  const del = await deleteMemoForUser(userId, memoId1)
  assert(del.deleted === true, 'deleteMemo 删除成功')

  // 游标分页
  await createMemoForUser(userId, '分页 #test 一')
  await createMemoForUser(userId, '分页 #test 二')
  const p1 = await listMemosForUser(userId, { limit: 1 })
  const cursor = p1.nextCursor
  assert(Boolean(cursor), '分页返回 nextCursor')
  const p2 = await listMemosForUser(userId, { limit: 1, cursor: cursor! })
  assert(p2.items.length === 1, '用 cursor 取到下一页')
  const badCursor = Buffer.from('not-json').toString('base64url')
  const pBad = await listMemosForUser(userId, { limit: 1, cursor: badCursor })
  assert(pBad.items.length === 1, '非法游标回退到首页')

  // LIKE 通配符转义
  await createMemoForUser(userId, '进度 100% 完成')
  const byPercent = await listMemosForUser(userId, { q: '%', limit: 10 })
  assert(
    byPercent.items.length === 1 &&
      byPercent.items[0]?.content.includes('100%'),
    '搜索转义 % 通配符',
  )

  // 三级标签：全深度筛选与父级计数
  const memo3 = (await createMemoForUser(userId, '三级 #a/b/c 嵌套标签测试')).id
  for (const tag of ['a', 'a/b', 'a/b/c']) {
    const hit = await listMemosForUser(userId, { tag, limit: 10 })
    assert(
      hit.items.some((i) => i.id === memo3),
      `按 ${tag} 筛选可命中三级标签 memo`,
    )
  }
  const tags3 = await listTagsForUser(userId)
  assert(
    (tags3.find((t) => t.name === 'a')?.count ?? 0) >= 1,
    '三级标签父级计数累加',
  )

  // 越权防护：另一个用户不能操作该用户的 memo
  const otherUsername = `other${Date.now().toString().slice(-8)}`
  const other = await auth.api.signUpEmail({
    body: {
      name: '别人',
      username: otherUsername,
      email: `other-${Date.now()}@mome.dev`,
      password: 'password123',
    },
    headers: new Headers(),
  })
  const delOther = await deleteMemoForUser(other.user.id, memoId2)
  assert(delOther.deleted === false, '其他用户不能删除他人 memo')

  // ── 公开页 ────────────────────────────────────────────
  const publicMemo = await createMemoForUser(userId, '公开测试 #public 内容')
  await setVisibilityForUser(userId, publicMemo.id, 'public')
  const newerPublicMemo = await createMemoForUser(
    userId,
    '较新的公开测试 #public 内容',
    { visibility: 'public' },
  )
  await togglePinForUser(userId, publicMemo.id)
  const profile = await getPublicProfileByUsername(username)
  assert(Boolean(profile), 'getPublicProfile 返回资料')
  assert(profile?.username === username, '资料用户名正确')

  const feed = await listPublicFeed(username, { limit: 10 })
  assert(feed.items.length >= 1, '公开主页包含公开 memo')
  assert(
    feed.items[0]?.memo.id === publicMemo.id && feed.items[0].memo.pinned,
    'timeline 置顶同步到个人主页首位',
  )
  const profilePinPage1 = await listPublicFeed(username, { limit: 1 })
  const profilePinPage2 = await listPublicFeed(username, {
    limit: 1,
    cursor: profilePinPage1.nextCursor!,
  })
  assert(
    profilePinPage1.items[0]?.memo.id === publicMemo.id &&
      profilePinPage2.items[0]?.memo.id === newerPublicMemo.id,
    '个人主页置顶项跨游标分页不重复且不遗漏普通 memo',
  )
  assert(
    feed.items.every((i) => i.memo.visibility === 'public'),
    '公开主页只显示公开 memo',
  )

  // 公共主页：聚合所有用户的公开 memo
  const firstGlobalPin = await toggleGlobalPinForAdmin(publicMemo.id)
  assert(firstGlobalPin.globalPinned, '管理员可全局置顶公开 memo')
  const globallyPinned = await listAllPublicMemos({ limit: 50 })
  assert(
    globallyPinned.items[0]?.memo.id === publicMemo.id &&
      globallyPinned.items[0].memo.globalPinned,
    '全局置顶 memo 排在公共主页首位',
  )
  const globalPinPage1 = await listAllPublicMemos({ limit: 1 })
  const globalPinPage2 = await listAllPublicMemos({
    limit: 1,
    cursor: globalPinPage1.nextCursor!,
  })
  assert(
    globalPinPage1.items[0]?.memo.id === publicMemo.id &&
      globalPinPage2.items[0]?.memo.id !== publicMemo.id,
    '公共主页全局置顶项跨游标分页不重复',
  )
  await toggleGlobalPinForAdmin(newerPublicMemo.id)
  const replacedGlobalPin = await listAllPublicMemos({ limit: 50 })
  assert(
    replacedGlobalPin.items[0]?.memo.id === newerPublicMemo.id &&
      replacedGlobalPin.items.filter((item) => item.memo.globalPinned)
        .length === 1 &&
      replacedGlobalPin.items.find((item) => item.memo.id === publicMemo.id)
        ?.memo.globalPinned === false,
    '新全局置顶替换旧全局置顶，全站只有一条',
  )
  let privateGlobalPinRejected = false
  try {
    await toggleGlobalPinForAdmin(memoId2)
  } catch {
    privateGlobalPinRejected = true
  }
  assert(privateGlobalPinRejected, '私密或归档 memo 不能全局置顶')

  const allPublic = await listAllPublicMemos({ limit: 50 })
  assert(
    allPublic.items.some((i) => i.memo.id === publicMemo.id),
    '公共主页聚合包含公开 memo',
  )
  assert(
    allPublic.items.some((i) => i.author?.id === userId),
    '公共主页返回作者信息',
  )

  const detail = await getPublicMemoDetail(username, publicMemo.id)
  assert(detail?.memo.id === publicMemo.id, '公开 memo 详情可读')
  const privateDetail = await getPublicMemoDetail(username, memoId2)
  assert(privateDetail === null, '私密 memo 对未登录访客不可读')
  const ownPrivate = await getPublicMemoDetail(username, memoId2, userId)
  assert(ownPrivate?.memo.id === memoId2, '作者本人可读私密 memo')

  // ── 互动 ──────────────────────────────────────────────
  const like = await toggleLikeForUser(other.user.id, publicMemo.id)
  assert(like.liked === true && like.counts.likes === 1, '点赞成功')
  const unlike = await toggleLikeForUser(other.user.id, publicMemo.id)
  assert(unlike.liked === false && unlike.counts.likes === 0, '取消点赞成功')
  await toggleLikeForUser(other.user.id, publicMemo.id)

  const fav = await toggleFavoriteForUser(other.user.id, publicMemo.id)
  assert(fav.favorited === true && fav.counts.favorites === 1, '收藏成功')

  const comment = await addCommentForUser(
    other.user.id,
    publicMemo.id,
    '好想法！',
  )
  assert(Boolean(comment.id), '评论成功')
  const comments = await listCommentsForMemo(publicMemo.id, { limit: 10 })
  assert(comments.items.length === 1, '评论列表返回 1 条')
  const delComment = await deleteCommentForUser(other.user.id, comment.id)
  assert(delComment.deleted === true, '评论作者可删除评论')

  const repost = await toggleRepostForUser(
    other.user.id,
    publicMemo.id,
    '转发了',
  )
  assert(repost.reposted === true && repost.counts.reposts === 1, '转发成功')
  const updatedRepost = await updateRepostForUser(
    other.user.id,
    publicMemo.id,
    '新附言',
  )
  assert(updatedRepost.reposted === true, '更新转发附言成功')
  const feed2 = await listPublicFeed(otherUsername, { limit: 10 })
  assert(
    feed2.items.some((i) => i.kind === 'repost' && i.memo.id === publicMemo.id),
    '转发出现在用户公开主页',
  )
  const feedRepost = feed2.items.find(
    (i) => i.kind === 'repost' && i.memo.id === publicMemo.id,
  )
  assert(
    feedRepost?.author?.username === username,
    '公开主页转发条目关联原作者',
  )
  assert(
    feedRepost?.repost?.reposter.username === otherUsername,
    '公开主页转发条目含转发者',
  )

  // 个人时间线包含转发，且关联原作者
  const homeFeed = await listHomeFeedForUser(other.user.id, { limit: 10 })
  const homeRepost = homeFeed.items.find(
    (i) => i.kind === 'repost' && i.memo.id === publicMemo.id,
  )
  assert(Boolean(homeRepost), '转发出现在个人时间线')
  assert(
    homeRepost?.author?.username === username,
    '个人时间线转发条目关联原作者',
  )

  // 互动页分类列表
  const likeInteractions = await listInteractionsForUser(
    other.user.id,
    'likes',
    {
      limit: 10,
    },
  )
  assert(
    likeInteractions.items.some((i) => i.memo.id === publicMemo.id),
    '互动页-点赞包含 memo',
  )
  const favoriteInteractions = await listInteractionsForUser(
    other.user.id,
    'favorites',
    { limit: 10 },
  )
  assert(
    favoriteInteractions.items.some((i) => i.memo.id === publicMemo.id),
    '互动页-收藏包含 memo',
  )
  const comment2 = await addCommentForUser(
    other.user.id,
    publicMemo.id,
    '再回复一条',
  )
  assert(Boolean(comment2.id), '再次评论成功')
  const commentInteractions = await listInteractionsForUser(
    other.user.id,
    'comments',
    { limit: 10 },
  )
  assert(
    commentInteractions.items.some(
      (i) => i.memo.id === publicMemo.id && i.content === '再回复一条',
    ),
    '互动页-回复包含 memo 与回复内容',
  )
  const repostInteractions = await listInteractionsForUser(
    other.user.id,
    'reposts',
    { limit: 10 },
  )
  assert(
    repostInteractions.items.some((i) => i.memo.id === publicMemo.id),
    '互动页-转发包含 memo',
  )

  const unRepost = await toggleRepostForUser(other.user.id, publicMemo.id)
  assert(unRepost.reposted === false, '取消转发成功')

  // 私密 memo 不能被他人互动
  let privateLikeRejected = false
  try {
    await toggleLikeForUser(other.user.id, memoId2)
  } catch {
    privateLikeRejected = true
  }
  assert(privateLikeRejected, '私密 memo 禁止他人点赞')

  // ── 导出 / 导入 ───────────────────────────────────────
  const exported = await exportMemosForUser(userId)
  assert(exported.length >= 2, '导出包含 memo')
  assert(
    exported.every((m) => Array.isArray(m.tags)),
    '导出包含标签数组',
  )
  const imported = await importMemosForUser(userId, exported)
  assert(
    imported.imported === 0 && imported.skipped === exported.length,
    '重复导入按 id 跳过',
  )
  const imported2 = await importMemosForUser(userId, [
    {
      content: '导入的新 memo #import',
      visibility: 'public',
      pinned: false,
      archived: false,
    },
  ])
  assert(imported2.imported === 1, '无 id 的导入创建新 memo')
  const byImportTag = await listMemosForUser(userId, {
    tag: 'import',
    limit: 10,
  })
  assert(byImportTag.items.length === 1, '导入 memo 标签解析成功')

  // ── 注销后同邮箱可重新注册 ─────────────────────────────
  const reuseEmail = `reuse-${Date.now()}@mome.dev`
  const reusePassword = 'reuse-pass-123'
  const reuseUsername = `reuse${Date.now().toString().slice(-8)}`
  async function httpApi(
    path: string,
    init: { method: string; body?: string },
    cookie?: string,
  ): Promise<{ status: number; body: any; setCookie?: string }> {
    const res = await auth.handler(
      new Request(`http://localhost:3000${path}`, {
        method: init.method,
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          ...(cookie ? { cookie } : {}),
        },
        body: init.body,
      }),
    )
    const text = await res.text()
    return {
      status: res.status,
      body: text ? JSON.parse(text) : null,
      setCookie: res.headers.get('set-cookie') ?? undefined,
    }
  }

  const r1 = await httpApi('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({
      name: '复用测试',
      username: reuseUsername,
      email: reuseEmail,
      password: reusePassword,
    }),
  })
  assert(r1.status === 200, '注册待注销用户成功')
  const reuseCookie = r1.setCookie?.split(';')[0]
  const delUser = await httpApi(
    '/api/auth/delete-user',
    {
      method: 'POST',
      body: JSON.stringify({ password: reusePassword, callbackURL: '/signup' }),
    },
    reuseCookie,
  )
  assert(
    delUser.status === 200 && delUser.body?.message === 'User deleted',
    '注销成功',
  )
  const r2 = await httpApi('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({
      name: '复用测试2',
      username: `reuse2${Date.now().toString().slice(-8)}`,
      email: reuseEmail,
      password: reusePassword,
    }),
  })
  assert(r2.status === 200, '注销后同邮箱可重新注册')

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
