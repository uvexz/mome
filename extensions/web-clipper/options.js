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
  try {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
  } catch {
    status.textContent = '请输入有效的 HTTP 或 HTTPS 地址。'
    return
  }
  await chrome.storage.local.set({ baseUrl, apiKey })
  status.textContent = '设置已保存。'
}
