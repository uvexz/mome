const form = document.querySelector('#settings-form')
const baseUrlInput = document.querySelector('#base-url')
const apiKeyInput = document.querySelector('#api-key')
const status = document.querySelector('#status')

form.addEventListener('submit', (event) => {
  event.preventDefault()
  void saveSettings()
})

void chrome.storage.local.get(['baseUrl', 'apiKey']).then((settings) => {
  baseUrlInput.value = settings.baseUrl ?? ''
  apiKeyInput.value = settings.apiKey ?? ''
})

async function saveSettings() {
  const baseUrl = baseUrlInput.value.trim().replace(/\/$/, '')
  const apiKey = apiKeyInput.value.trim()
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    status.textContent = '请输入有效的地址。'
    return
  }
  // 仅允许 HTTPS（localhost 例外），API key 绝不通过明文 HTTP 传输
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    status.textContent =
      '为保护 API key，地址必须使用 HTTPS（本地 localhost 除外）。'
    return
  }
  // 按需申请对目标站点的访问权限（替代 manifest 的 <all_urls>）
  const granted = await chrome.permissions.request({
    origins: [`${url.origin}/*`],
  })
  if (!granted) {
    status.textContent = '未授予访问该站点的权限，设置未保存。'
    return
  }
  await chrome.storage.local.set({ baseUrl, apiKey })
  status.textContent = '设置已保存。'
}
