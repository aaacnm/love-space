// 恋爱手账 Service Worker
// 策略：network-first（网络优先，失败才回退缓存）——保证发新版后手机上
// 不会一直卡在旧版本；只缓存同源静态资源，Supabase 请求一律直连。
const CACHE = 'love-cache-v2'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.clients
      .claim()
      .then(() => caches.keys())
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
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

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  let url
  try {
    url = new URL(req.url)
  } catch {
    return
  }
  if (url.origin !== location.origin) return // Supabase / 字体等跨域直连

  event.respondWith(
    fetch(req)
      .then((res) => {
        // 缓存成功的静态资源与页面，用于断网兜底
        if (res && res.ok && (req.mode === 'navigate' || url.pathname.startsWith('/assets/'))) {
          const clone = res.clone()
          caches.open(CACHE).then((c) => c.put(req, clone))
        }
        return res
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : undefined)),
      ),
  )
})
