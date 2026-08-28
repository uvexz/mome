// 缓存策略：
// - vite 构建产物（/assets/ 下的带哈希文件名）→ cache-first（文件名即版本，安全）
// - 其余静态文件（theme-init.js、图标等）→ stale-while-revalidate，
//   避免 CACHE_NAME 忘记升级时用户长期命中旧版本
// activate 时按插入顺序裁剪哈希资源，防止历次发版的旧产物在缓存里无限累积
const CACHE_NAME = 'mome-static-v1'
const MAX_CACHED_ASSETS = 200
const STATIC_ASSETS = [
  '/favicon.png',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png',
  '/theme-init.js',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  )
})

/** 超出上限时删除最早的哈希资源（cache.keys() 按插入顺序返回） */
async function trimHashedAssets() {
  const cache = await caches.open(CACHE_NAME)
  const requests = await cache.keys()
  const hashed = requests.filter((request) =>
    isHashedAsset(new URL(request.url)),
  )
  if (hashed.length <= MAX_CACHED_ASSETS) return
  const stale = hashed.slice(0, hashed.length - MAX_CACHED_ASSETS)
  await Promise.all(stale.map((request) => cache.delete(request)))
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => trimHashedAssets())
      .then(() => self.clients.claim()),
  )
})

function isStaticAsset(url) {
  return (
    url.origin === self.location.origin &&
    /\.(?:css|js|png|jpg|jpeg|svg|ico|woff2?)$/i.test(url.pathname)
  )
}

/** vite 构建产物：/assets/xxx.<8+位哈希>.js|css */
function isHashedAsset(url) {
  return /\/assets\/[^/]+[-.][a-f0-9]{8,}\.(?:css|js)$/i.test(url.pathname)
}

function fetchAndCache(request) {
  return fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone()
      void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
    }
    return response
  })
}

/** 立即返回缓存（若有），同时后台刷新缓存 */
function staleWhileRevalidate(request) {
  const network = fetchAndCache(request)
  return caches
    .match(request)
    .then((cached) => cached ?? network)
    .catch(() => network)
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (!isStaticAsset(url)) return

  event.respondWith(
    isHashedAsset(url)
      ? caches.match(request).then((cached) => cached ?? fetchAndCache(request))
      : staleWhileRevalidate(request),
  )
})
