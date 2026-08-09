import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const email = `e2e-${Date.now()}@mome.dev`
const pass = 'e2e-password-123'
const username = `user${Date.now().toString().slice(-8)}`

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
const page = await context.newPage()

// WebAuthn 虚拟认证器（Passkey e2e 用）
const cdp = await context.newCDPSession(page)
await cdp.send('WebAuthn.enable')
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
  },
})

const log = (m) => console.log(m)
let fails = 0
const ok = (cond, msg) => {
  log((cond ? '  ✓ ' : '  ✗ ') + msg)
  if (!cond) fails++
}

// 等待客户端水合完成：React 会在 DOM 节点上挂 __reactProps$* 属性
async function isHydrated(page) {
  try {
    return await page
      .waitForFunction(
        () =>
          Array.from(document.querySelectorAll('button, input, a')).some((el) =>
            Object.keys(el).some((k) => k.startsWith('__reactProps$')),
          ),
        { timeout: 5000 },
      )
      .then(() => true)
  } catch {
    return false
  }
}

async function waitForApp(page, { retry = false } = {}) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 })
  } catch {
    // 忽略超时，以水合检测为准
  }
  let hydrated = await isHydrated(page)
  if (!hydrated && retry) {
    // Vite 冷启动首次依赖优化时动态导入可能失败，重载一次即可恢复
    await page.reload({ waitUntil: 'load' })
    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 })
    } catch {}
    hydrated = await isHydrated(page)
  }
  if (!hydrated) throw new Error('应用未完成水合（客户端 JS 未就绪）')
}

try {
  // 1. 注册
  await page.goto(`${BASE}/signup`)
  await waitForApp(page, { retry: true })
  await page.getByLabel('昵称').fill('E2E 用户')
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('邮箱').fill(email)
  await page.getByLabel('密码', { exact: true }).fill(pass)
  await page.getByRole('button', { name: '注册' }).click()
  // 1.5 注册后邮箱验证（OTP）
  await page.getByLabel('邮箱验证码').waitFor({ timeout: 10000 })
  ok(true, '注册后进入邮箱验证步骤')
  await page.waitForTimeout(600)
  const otpSignupRes = await page.request.get(
    `${BASE}/api/dev-otp?email=${encodeURIComponent(email)}&type=email-verification`,
  )
  const otpSignupJson = await otpSignupRes.json()
  ok(
    typeof otpSignupJson.otp === 'string' && otpSignupJson.otp.length === 6,
    '注册验证码可读取',
  )
  await page.getByLabel('邮箱验证码').fill(otpSignupJson.otp)
  await page.getByRole('button', { name: '验证邮箱' }).click()
  await page.waitForURL('**/')
  ok(true, '验证邮箱后跳转到 /')

  // 1.5 品牌：logo / 头像 / favicon
  await page.waitForSelector('header img[src="/favicon.png"]')
  const headerLogo = await page.evaluate(
    () => !!document.querySelector('header img[src="/favicon.png"]'),
  )
  ok(headerLogo, '顶栏 logo 使用 /favicon.png')
  try {
    await page.waitForSelector('header img[src*="cdn.sevencdn.com"]', {
      timeout: 5000,
    })
    ok(true, '用户头像使用 gravatar (cdn.sevencdn.com)')
  } catch {
    ok(false, '用户头像使用 gravatar (cdn.sevencdn.com)')
  }
  const favicon = await page.evaluate(
    () => !!document.querySelector('link[rel="icon"][href="/favicon.png"]'),
  )
  ok(favicon, 'favicon 指向 /favicon.png')

  // 2. 写 memo（含标签）
  await page.getByLabel('新 memo').fill('第一条 e2e **加粗** #工作/会议 记录')
  await page.keyboard.press('Meta+Enter')
  await page.waitForTimeout(600)
  if ((await page.locator('article').count()) === 0) {
    await page.getByRole('button', { name: '发送' }).click()
    await page.waitForTimeout(800)
  }
  const content1 = await page.locator('article').first().textContent()
  ok(content1.includes('第一条 e2e'), 'Composer 提交后出现在时间线')
  ok(content1.includes('#工作/会议'), '标签文本被渲染')
  ok((content1.match(/#/g) || []).length === 1, '标签只渲染一个 #')
  const boldText = await page.locator('article strong').first().textContent()
  ok(boldText?.includes('加粗'), 'Markdown 加粗渲染')

  // 3. 再写一条
  await page.getByLabel('新 memo').fill('第二条 #生活')
  await page.getByRole('button', { name: '发送' }).click()
  await page.waitForTimeout(600)

  // 4. 标签筛选
  await page
    .getByRole('button', { name: /#工作\/会议/ })
    .first()
    .click()
  await page.waitForTimeout(800)
  const filtered = await page.locator('article').count()
  ok(filtered === 1, `按标签筛选后 1 条 (实际 ${filtered})`)
  // 清除
  await page
    .getByRole('button', { name: /#工作\/会议/ })
    .first()
    .click()
  await page.waitForTimeout(600)

  // 5. 搜索
  await page.getByLabel('搜索 memo').fill('第二条')
  await page.waitForTimeout(800)
  const searched = await page.locator('article').count()
  ok(searched === 1, `搜索命中 1 条 (实际 ${searched})`)
  await page.getByLabel('搜索 memo').fill('')
  await page.waitForTimeout(600)

  // 6. 编辑
  await page.locator('article').first().hover()
  await page.getByRole('button', { name: 'memo 操作' }).first().click()
  await page.getByRole('menuitem', { name: '编辑' }).click()
  await page.getByLabel('编辑 memo 内容').waitFor()
  const ta = page.getByLabel('编辑 memo 内容')
  await ta.fill('编辑后的内容 #更新')
  await page.getByRole('button', { name: '保存' }).click()
  await page.waitForTimeout(700)
  const edited = await page.locator('article').first().textContent()
  ok(edited.includes('编辑后的内容'), '编辑保存生效')

  // 7. 置顶
  await page.getByRole('button', { name: 'memo 操作' }).first().click()
  await page.getByRole('menuitem', { name: '置顶' }).click()
  await page.waitForTimeout(700)
  const firstCard = await page.locator('article').first().textContent()
  ok(
    firstCard.includes('置顶') && firstCard.includes('编辑后的内容'),
    '置顶后排在首位并显示标记',
  )

  // 8. 归档
  await page.getByRole('button', { name: 'memo 操作' }).first().click()
  await page.getByRole('menuitem', { name: '归档' }).click()
  await page.waitForTimeout(600)
  const afterArchive = await page.locator('article').count()
  ok(afterArchive === 1, `归档后剩余 1 条 (实际 ${afterArchive})`)
  // 归档视图
  await page.getByRole('button', { name: '归档' }).click()
  await page.waitForTimeout(800)
  const archivedCount = await page.locator('article').count()
  ok(archivedCount === 1, `归档视图 1 条 (实际 ${archivedCount})`)
  // 恢复
  await page.getByRole('button', { name: 'memo 操作' }).first().click()
  await page.getByRole('menuitem', { name: '取消归档' }).click()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: '我的' }).click()
  await page.waitForTimeout(600)
  const restored = await page.locator('article').count()
  ok(restored === 2, `恢复后 2 条 (实际 ${restored})`)

  // 9. 删除（确认对话框）
  await page.locator('article').first().hover()
  await page.getByRole('button', { name: 'memo 操作' }).first().click()
  await page.getByRole('menuitem', { name: '删除' }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.waitForTimeout(700)
  const afterDelete = await page.locator('article').count()
  ok(afterDelete === 1, `删除后剩余 1 条 (实际 ${afterDelete})`)

  // 10. 暗色模式切换
  const modeBefore = await page.evaluate(() =>
    document.documentElement.getAttribute('data-mode'),
  )
  await page.getByRole('button', { name: /切换到暗色模式/ }).click()
  await page.waitForTimeout(200)
  const modeAfter = await page.evaluate(() =>
    document.documentElement.getAttribute('data-mode'),
  )
  ok(
    modeBefore === 'light' && modeAfter === 'dark',
    `主题切换 light→dark (${modeBefore}→${modeAfter})`,
  )

  // 11. 刷新后主题保持
  await page.reload()
  await waitForApp(page)
  const modeReload = await page.evaluate(() =>
    document.documentElement.getAttribute('data-mode'),
  )
  ok(modeReload === 'dark', `刷新后主题保持 dark (${modeReload})`)

  // 12. 每日回顾
  await page.getByRole('button', { name: '每日回顾' }).click()
  await page.waitForURL('**/review')
  await page.waitForTimeout(1200)
  const reviewCount = await page.locator('article').count()
  ok(reviewCount > 0, `每日回顾显示 ${reviewCount} 条`)
  await page.getByRole('button', { name: '再来一批' }).click()
  await page.waitForTimeout(800)
  ok(true, '再来一批可重新抽取')
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForURL('**/')
  await page.waitForTimeout(800)

  // 13. 退出登录
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()
  await page.waitForURL('**/explore')
  ok(true, '退出登录跳转到公共主页')
  await waitForApp(page)

  // 13. 公共主页登录弹窗
  await page.getByRole('button', { name: '登录' }).first().click()
  await page.waitForTimeout(400)
  await page.getByLabel('邮箱').fill(email)
  await page.getByLabel('密码', { exact: true }).fill(pass)
  await page.getByRole('button', { name: '登录' }).last().click()
  await page.waitForURL('**/')
  ok(true, '公共主页登录弹窗登录成功')

  // 14. 公开页与互动
  await page.getByLabel('新 memo').fill('公开测试 #e2e')
  await page.getByRole('button', { name: '公开' }).click()
  await page.getByRole('button', { name: '发送' }).click()
  await page.waitForTimeout(700)
  const publicBadge = page.locator('article').first().getByRole('img', {
    name: '公开',
  })
  ok(await publicBadge.isVisible(), 'memo 可切换为公开并显示图标标记')

  // 14.5 公共主页聚合所有用户公开 memo
  await page.getByRole('button', { name: '公共主页' }).click()
  await page.waitForURL('**/explore')
  await page.waitForTimeout(800)
  const exploreText = await page.locator('article').first().textContent()
  ok(exploreText.includes('公开测试'), '公共主页展示公开 memo')
  // 14.6 公共主页按标签筛选（不跳回个人首页）
  await page.getByRole('button', { name: '#e2e' }).first().click()
  await page.waitForURL('**/explore?tag=e2e')
  await page.waitForTimeout(800)
  const tagFiltered = await page.locator('article').first().textContent()
  ok(tagFiltered.includes('公开测试'), '公共主页标签筛选命中 memo')
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForURL('**/')
  await page.waitForTimeout(600)

  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '我的主页' }).click()
  await page.waitForURL(`**/@${username}`)
  await page.waitForTimeout(800)
  const profileText = await page.locator('article').first().textContent()
  ok(profileText.includes('公开测试'), '公开主页展示公开 memo')

  // 点赞
  await page.getByRole('button', { name: /点赞/ }).first().click()
  await page.waitForTimeout(600)
  const liked = await page.locator('article').first().textContent()
  ok(liked.includes('1'), '点赞计数为 1')

  // 评论（对话框）
  await page.getByRole('button', { name: '评论' }).first().click()
  await page.getByLabel('新评论').fill('e2e 评论')
  await page.getByRole('button', { name: '发送评论' }).click()
  await page.waitForTimeout(700)
  const commentVisible = await page.locator('text=e2e 评论').first().isVisible()
  ok(commentVisible, '评论发布并显示在对话框中')
  await page.getByRole('button', { name: '关闭' }).click()

  // 时间可点击 → memo 详情页
  await page.getByTitle('查看 memo 详情页').first().click()
  await page.waitForURL(`**/@${username}/*`)
  ok(true, '点击时间跳转 memo 详情页')
  await page.locator('header', { hasText: 'memo' }).waitFor({ timeout: 5000 })
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForURL(`**/@${username}`)

  // 15. 设置页 + Passkey
  await page.goto(`${BASE}/settings`)
  await waitForApp(page)
  ok(
    await page.getByRole('heading', { name: '个人资料' }).isVisible(),
    '设置页显示个人资料区块',
  )
  await page.getByRole('button', { name: '添加 Passkey' }).click()
  await page.waitForTimeout(1200)
  const passkeyAdded = await page.locator('text=添加于').first().isVisible()
  ok(passkeyAdded, 'Passkey 注册成功并出现在列表中')

  // 16. Passkey 登录
  await page.goto(`${BASE}/`)
  await waitForApp(page)
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()
  await page.waitForURL('**/explore')
  await waitForApp(page)
  await page.getByRole('button', { name: '登录' }).first().click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Passkey' }).click()
  await page.getByRole('button', { name: '使用 Passkey 登录' }).click()
  await page.waitForURL('**/', { timeout: 15000 })
  ok(true, 'Passkey 登录成功')
  await waitForApp(page)

  // 17. OTP 登录
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()
  await page.waitForURL('**/explore')
  await waitForApp(page)
  await page.getByRole('button', { name: '登录' }).first().click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: '验证码' }).click()
  await page.getByLabel('邮箱').fill(email)
  await page.getByRole('button', { name: '发送验证码' }).click()
  await page.waitForTimeout(800)
  const otpRes = await page.request.get(
    `${BASE}/api/dev-otp?email=${encodeURIComponent(email)}&type=sign-in`,
  )
  const otpJson = await otpRes.json()
  ok(
    typeof otpJson.otp === 'string' && otpJson.otp.length === 6,
    '开发环境可读取 OTP',
  )
  await page.getByLabel('验证码').fill(otpJson.otp)
  await page.getByRole('button', { name: '登录' }).last().click()
  await page.waitForURL('**/')
  ok(true, '邮箱验证码登录成功')
  await waitForApp(page)

  // 18. 更换邮箱：密码 + 新邮箱验证码
  await page.goto(`${BASE}/settings`)
  await waitForApp(page)
  const newEmail = `e2e-new-${Date.now()}@mome.dev`
  const emailSection = page.locator('section', {
    hasText: '验证身份后向新邮箱发送验证码',
  })
  const currentPasswordInput = emailSection.locator(
    'input[aria-label="当前密码"]:not([readonly])',
  )
  await page.getByLabel('新邮箱', { exact: true }).fill(newEmail)
  await currentPasswordInput.first().fill('wrong-password')
  await page.getByRole('button', { name: '发送验证码' }).click()
  await page.waitForTimeout(700)
  const wrongPw = await page
    .locator('text=当前密码不正确')
    .first()
    .isVisible()
    .catch(() => false)
  ok(wrongPw, '更换邮箱先校验当前密码')
  // 密码框有值后会进入遮罩只读态，刷新后重新填写正确密码
  await page.reload()
  await waitForApp(page)
  await page.getByLabel('新邮箱', { exact: true }).fill(newEmail)
  await emailSection
    .locator('input[aria-label="当前密码"]:not([readonly])')
    .first()
    .fill(pass)
  await page.getByRole('button', { name: '发送验证码' }).click()
  let otpChange = null
  for (let i = 0; i < 10 && !otpChange; i++) {
    await page.waitForTimeout(500)
    const otpChangeRes = await page.request.get(
      `${BASE}/api/dev-otp?email=${encodeURIComponent(newEmail)}&type=change-email`,
    )
    const otpChangeJson = await otpChangeRes.json()
    otpChange = typeof otpChangeJson.otp === 'string' ? otpChangeJson.otp : null
  }
  ok(typeof otpChange === 'string', '新邮箱验证码可读取')
  await page.getByLabel('新邮箱验证码', { exact: true }).fill(otpChange)
  await page.getByRole('button', { name: '确认更换' }).click()
  await page.waitForTimeout(800)
  const emailChanged = await page
    .locator('text=邮箱已更新')
    .first()
    .isVisible()
    .catch(() => false)
  ok(emailChanged, '更换邮箱成功')

  // 19. 未登录访问 / 被重定向
  await page.context().clearCookies()
  await page.goto(`${BASE}/`)
  await page.waitForURL('**/explore')
  ok(true, '未登录访问 / 重定向到公共主页')
  const loginEntry = await page
    .getByRole('button', { name: '登录' })
    .first()
    .isVisible()
  ok(loginEntry, '公共主页显示登录入口')
} catch (e) {
  console.error('E2E ERROR:', e.message)
  fails++
}

await browser.close()
console.log(`\nE2E 结果: ${fails === 0 ? '全部通过' : fails + ' 项失败'}`)
process.exit(fails === 0 ? 0 : 1)
