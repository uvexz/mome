const MENU_ID = 'save-to-mome'

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '保存到 mome',
    contexts: ['page', 'selection', 'link'],
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.url) return
  void saveClip({
    title: tab.title ?? '',
    url: info.linkUrl ?? tab.url,
    description: '',
    content: info.selectionText ?? '',
    tags: [],
    visibility: 'private',
    clientId: crypto.randomUUID(),
  })
})

async function saveClip(clip) {
  const { baseUrl, apiKey } = await chrome.storage.local.get([
    'baseUrl',
    'apiKey',
  ])
  if (!baseUrl || !apiKey) {
    await showBadge('!')
    await chrome.runtime.openOptionsPage()
    return
  }

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/clips`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': clip.clientId,
      },
      body: JSON.stringify(clip),
    })
    await showBadge(response.ok ? 'OK' : '!')
  } catch {
    await showBadge('!')
  }
}

async function showBadge(text) {
  await chrome.action.setBadgeBackgroundColor({
    color: text === 'OK' ? '#16825d' : '#c2413b',
  })
  await chrome.action.setBadgeText({ text })
  setTimeout(() => void chrome.action.setBadgeText({ text: '' }), 1800)
}
