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
  page = {
    title: tab.title ?? '',
    url: tab.url,
    description: result?.description ?? '',
  }
  titleInput.value = page.title
  contentInput.value = result?.selection ?? ''
  source.textContent = new URL(page.url).hostname
  const saved = await chrome.storage.local.get(['visibility'])
  visibilityInput.value = saved.visibility ?? 'private'
}

async function submitClip() {
  if (!page) return
  const { baseUrl, apiKey } = await chrome.storage.local.get([
    'baseUrl',
    'apiKey',
  ])
  if (!baseUrl || !apiKey) {
    showStatus('请先完成扩展设置。', true)
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
    const body = await response.json()
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
