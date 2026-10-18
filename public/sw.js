// 恋爱手账 Service Worker
//
// 缓存策略按「资源性质」分三层（越靠上越快）：
//
//   1) 带内容 hash 的构建产物（/assets/index-a1b2c3d4.js 这类）→ cache-first。
//      文件名本身就是内容指纹，内容永不变化，可以长期缓存：命中就直接返回，
//      一秒都不等网络。新版本引用的是新文件名，永远不会撞上旧缓存。
//
//   2) 页面导航（HTML）→ network-first + 超时兜底。最多等 NAV_TIMEOUT_MS 毫秒，
//      超时（或断网）立刻回退缓存。弱网下首屏不再干等，同时保证发新版能拿到新 HTML。
//
//   3) 其它同源静态资源（图标、字体、清单，以及没有 hash 的源码模块 /src/**）
//      → 同样 network-first，但超时更短。它们没有内容指纹，长期钉住会让手机
//      一直吃旧代码，所以让网络优先；但弱网/断网时仍用缓存兜底，而不是白屏。
//
// 发新版：把下面的 VERSION 加一。activate 时会删掉所有旧版本缓存 —— 带 hash 的资源
// 本来就不会冲突，这一步主要是清垃圾，以及让长期不关的页面丢掉过期的兜底数据。
//
// 一律不接管：跨域请求（Supabase、字体 CDN 等）、非 GET、带 Range 的请求
//             （音视频拖动靠它直连）、以及 sw.js 自己。
const VERSION = 'v3'

const STATIC_CACHE = `love-static-${VERSION}`
const PAGES_CACHE = `love-pages-${VERSION}`
const KEEP_CACHES = [STATIC_CACHE, PAGES_CACHE]

// 导航最多等网络这么久，超时就走缓存（用户体感：宁可稍旧，也不要转圈）
const NAV_TIMEOUT_MS = 1500
// 无 hash 的源码模块 / 静态资源：短暂等网络，保证发新版能及时生效
const CODE_TIMEOUT_MS = 1200

self.addEventListener('install', (event) => {
  self.skipWaiting()
  // 预热页面缓存：这样「第二次打开且网络慢」时，1.5s 后一定有东西可回退
  event.waitUntil(
    caches
      .open(PAGES_CACHE)
      .then((cache) => cache.add('/'))
      .catch(() => {
        /* 预热失败不该让安装失败 */
      }),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.clients
      .claim()
      .then(() => caches.keys())
      .then((keys) =>
        Promise.all(keys.filter((k) => !KEEP_CACHES.includes(k)).map((k) => caches.delete(k))),
      ),
  )
})

// 点击系统通知：把 App 带回前台并跳到对应页面（页面监听 message 转成 app:goto）
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const tab = (event.notification.data && event.notification.data.tab) || null
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of all) {
        if (client.url && client.url.startsWith(self.location.origin)) {
          await client.focus()
          client.postMessage({ type: 'app:goto', tab })
          return
        }
      }
      await self.clients.openWindow(self.location.origin + '/')
    })(),
  )
})

// 服务器推送到达（Web Push）：App 完全关闭/后台冻结时，由系统唤醒本 SW 弹通知
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    (async () => {
      // 前台有可见页面 → 页面内的实时横幅已经在提示，吞掉推送避免双重打扰
      try {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        if (all.some((c) => c.visibilityState === 'visible')) return
      } catch {
        /* 检测失败照常弹，宁可重复不可漏掉 */
      }
      const tab = data.tab || null
      await self.registration.showNotification(data.title || '💗 恋爱手账', {
        body: data.body || 'TA 有新动态啦，点开看看',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: data.tag || 'love-' + (tab || 'home'),
        data: { tab },
      })
    })(),
  )
})

// ---------- 缓存判据 ----------

// 文件名里带内容指纹，例如 index-a1b2c3d4.js / baloo2-latin-var-9f8e7d6c.woff2
const HASHED_NAME = /-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/i
const STATIC_EXT = /\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|webp|avif|svg|gif|ico)$/i

// Vite dev server 直出的源码没有 hash（/src/**、/@vite/**、/@react-refresh、/node_modules/.vite/**），
// 绝不能当不可变资源钉死，否则改了代码手机还在跑旧模块
const isSourcePath = (p) =>
  p.startsWith('/src/') || p.startsWith('/@') || p.startsWith('/node_modules/')

const isImmutable = (p) =>
  !isSourcePath(p) && (p.startsWith('/assets/') || (STATIC_EXT.test(p) && HASHED_NAME.test(p)))

const isCacheable = (res) => {
  if (!res || !res.ok) return false
  if (res.type === 'opaque' || res.type === 'opaqueredirect') return false
  return !/no-store/i.test(res.headers.get('cache-control') || '')
}

// 网络优先，但最多等 ms：超时/断网都算失败，交由调用方回退缓存
function fetchWithTimeout(req, ms) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  return fetch(req, { signal: ac.signal }).finally(() => clearTimeout(timer))
}

// 1) 带 hash 的产物：命中即返回，一次网络都不发
async function cacheFirst(req) {
  const cache = await caches.open(STATIC_CACHE)
  const hit = await cache.match(req)
  if (hit) return hit
  try {
    const res = await fetch(req)
    if (isCacheable(res)) cache.put(req, res.clone()).catch(() => {})
    return res
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' })
  }
}

// 3) 无 hash 的源码 / 静态资源：网络优先 + 短超时，缓存兜底
async function networkFirst(req) {
  const cache = await caches.open(STATIC_CACHE)
  try {
    const res = await fetchWithTimeout(req, CODE_TIMEOUT_MS)
    if (isCacheable(res)) cache.put(req, res.clone()).catch(() => {})
    return res
  } catch {
    const hit = await cache.match(req)
    if (hit) return hit
    return new Response('', { status: 504, statusText: 'Offline' })
  }
}

// 2) 导航：网络优先 + 超时回退。缓存统一存在 '/' 这个键上（这个 App 没有路由，
//    所有导航都是同一个壳），避免 navigate 模式 Request 在 Cache 里的存储限制。
async function navigate(req) {
  const cache = await caches.open(PAGES_CACHE)
  try {
    const res = await fetchWithTimeout(req, NAV_TIMEOUT_MS)
    if (isCacheable(res)) cache.put('/', res.clone()).catch(() => {})
    return res
  } catch {
    const hit = (await cache.match(req).catch(() => null)) || (await cache.match('/'))
    if (hit) return hit
    return new Response('', { status: 504, statusText: 'Offline' })
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  if (req.headers.has('range')) return // 音视频拖动：交给网络，缓存会破坏 206
  if (req.destination === 'video' || req.destination === 'audio') return
  let url
  try {
    url = new URL(req.url)
  } catch {
    return
  }
  if (url.origin !== location.origin) return // Supabase 等跨域直连
  if (url.pathname === '/sw.js') return // 别把 SW 自己缓存住，否则永远升不了级

  if (req.mode === 'navigate') {
    event.respondWith(navigate(req))
    return
  }
  if (isImmutable(url.pathname)) {
    event.respondWith(cacheFirst(req))
    return
  }
  event.respondWith(networkFirst(req))
})
