const form = document.querySelector('#clip-form')
const titleInput = document.querySelector('#title')
const contentInput = document.querySelector('#content')
const tagsInput = document.querySelector('#tags')
const visibilityInput = document.querySelector('#visibility')
const source = document.querySelector('#source')
const status = document.querySelector('#status')
const submit = document.querySelector('#submit')
let page = null

document.querySelector('#settings').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

form.addEventListener('submit', (event) => {
  event.preventDefault()
  void submitClip()
})

void initialize()

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !tab.url) return
  // chrome:// 等受限页或未授予 host permission 时 executeScript 会抛错：
  // 捕获后明确提示"无法剪藏当前页"，而不是按钮点击无反应
  let pageData = null
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        selection: window.getSelection()?.toString().trim() ?? '',
        description:
          document.querySelector('meta[name="description"]')?.content ??
          document.querySelector('meta[property="og:description"]')?.content ??
          '',
      }),
    })
    pageData = result ?? null
  } catch {
    showStatus('无法读取当前页面内容（受限页面或未授予该站点权限）。', true)
    return
  }
  let hostname = ''
  try {
    hostname = new URL(tab.url).hostname
  } catch {
    showStatus('当前页面地址无效。', true)
    return
  }
  page = {
    title: tab.title ?? '',
    url: tab.url,
    description: pageData.description ?? '',
  }
  titleInput.value = page.title
  contentInput.value = pageData.selection ?? ''
  source.textContent = hostname
  const saved = await chrome.storage.local.get(['visibility'])
  visibilityInput.value = saved.visibility ?? 'private'
}

async function submitClip() {
  if (!page) {
    showStatus('当前页面不可剪藏。', true)
    return
  }
  const { baseUrl, apiKey } = await chrome.storage.local.get([
    'baseUrl',
    'apiKey',
  ])
  if (!baseUrl || !apiKey) {
    showStatus('请先完成扩展设置。', true)
    await chrome.runtime.openOptionsPage()
    return
  }
  // 仅允许 HTTPS（localhost 例外），API key 绝不通过明文 HTTP 传输
  try {
    const url = new URL(baseUrl)
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
      throw new Error('地址必须使用 HTTPS')
    }
  } catch (error) {
    showStatus(error instanceof Error ? error.message : '地址无效。', true)
    await chrome.runtime.openOptionsPage()
    return
  }

  submit.disabled = true
  submit.textContent = '保存中…'
  showStatus('')
  const clientId = crypto.randomUUID()
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/clips`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': clientId,
      },
      body: JSON.stringify({
        title: titleInput.value,
        url: page.url,
        description: page.description,
        content: contentInput.value,
        tags: tagsInput.value.split(/[,，\s]+/).filter(Boolean),
        visibility: visibilityInput.value,
        clientId,
      }),
    })
    // 非 JSON 响应（代理/网关的错误页等）不能让 json() 抛错掩盖真实状态码
    const text = await response.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    if (!response.ok) {
      throw new Error(body?.error?.message ?? `请求失败 (${response.status})`)
    }
    await chrome.storage.local.set({ visibility: visibilityInput.value })
    showStatus('已保存。')
    setTimeout(() => window.close(), 700)
  } catch (error) {
    showStatus(error instanceof Error ? error.message : '保存失败。', true)
    submit.disabled = false
    submit.textContent = '保存'
  }
}

function showStatus(message, error = false) {
  status.textContent = message
  status.classList.toggle('error', error)
}
