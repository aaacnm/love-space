// @vitest-environment node
/**
 * Service Worker 缓存策略的行为测试。
 *
 * 不是扫源码字符串，而是把 public/sw.js 真的放进一个假的 SW 环境里执行：
 * 假 self（收集事件监听）、假 caches（内存实现，语义对齐真 Cache API：
 * match 返回可消费的新 Response、put 读取并保存副本）、假 fetch（可计数、可挂起）。
 * 于是「第二次打开有没有发网络请求」「慢网有没有回退缓存」都是可断言的事实。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ORIGIN = 'https://love.test'
const SW_SOURCE = readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8')

const STATIC_CACHE = 'love-static-v3'
const PAGES_CACHE = 'love-pages-v3'

// 让未完成的 promise 有机会跑完（sw.js 里 cache.put 是 fire-and-forget）
const tick = () => new Promise((r) => setTimeout(r, 0))

/**
 * 触发「等网络超时」那一刻。
 * 必须先把控制权交回事件循环：fetch 处理函数在 await caches.open() 处让出，
 * 之后再同步走到 fetchWithTimeout 注册定时器 —— 直接 fireAll 会扑空。
 */
async function fireTimeout(sw) {
  for (let i = 0; i < 10 && sw.clock.pending() === 0; i++) await tick()
  expect(sw.clock.pending(), '此时应有一个等待中的超时定时器').toBeGreaterThan(0)
  sw.clock.fireAll()
}

// ---------- 假网络 ----------

const ok = (body, { headers = {} } = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } })

/** 永不返回，只在被 abort 时拒绝 —— 模拟「弱网挂住」 */
const hang = ({ init }) =>
  new Promise((_, reject) => {
    const s = init && init.signal
    if (!s) return
    s.addEventListener('abort', () => reject(new Error('aborted')))
  })

function makeNet(routes = {}) {
  const calls = []
  const net = async (req, init) => {
    const url = typeof req === 'string' ? new URL(req, ORIGIN).toString() : req.url
    const { pathname, search } = new URL(url)
    calls.push(pathname + search)
    const route = routes[pathname]
    if (!route) throw new TypeError('Failed to fetch ' + url)
    return route({ url, init, pathname })
  }
  net.calls = calls
  net.set = (pathname, route) => {
    routes[pathname] = route
  }
  return net
}

// ---------- 假 Cache Storage ----------

const keyOf = (req) => (typeof req === 'string' ? new URL(req, ORIGIN).toString() : req.url)
const snapshot = async (res) => ({
  status: res.status,
  statusText: res.statusText,
  headers: [...res.headers],
  body: await res.clone().text(),
})
const rebuild = (s) => new Response(s.body, { status: s.status, statusText: s.statusText, headers: s.headers })

function makeCaches(net, seed = []) {
  const stores = new Map(seed.map((n) => [n, new Map()]))
  const cacheApi = (store) => ({
    async match(req) {
      const snap = store.get(keyOf(req))
      return snap ? rebuild(snap) : undefined
    },
    async put(req, res) {
      store.set(keyOf(req), await snapshot(res))
    },
    async add(req) {
      const res = await net(req)
      if (!res.ok) throw new Error('add failed')
      store.set(keyOf(req), await snapshot(res))
    },
  })
  const api = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map())
      return cacheApi(stores.get(name))
    },
    async keys() {
      return [...stores.keys()]
    },
    async delete(name) {
      return stores.delete(name)
    },
    async has(name) {
      return stores.has(name)
    },
    async match(req) {
      for (const store of stores.values()) {
        const snap = store.get(keyOf(req))
        if (snap) return rebuild(snap)
      }
      return undefined
    },
    /** 测试用：直接看某个缓存里的键 */
    _keys: (name) => [...(stores.get(name)?.keys() ?? [])],
    _has: (name, url) => stores.get(name)?.has(new URL(url, ORIGIN).toString()) ?? false,
  }
  return api
}

// ---------- 假时钟（掌控超时那一刻） ----------

function makeClock() {
  const jobs = new Map()
  let next = 1
  return {
    setTimeout(fn) {
      const id = next++
      jobs.set(id, fn)
      return id
    },
    clearTimeout(id) {
      jobs.delete(id)
    },
    pending: () => jobs.size,
    fireAll() {
      const fns = [...jobs.values()]
      jobs.clear()
      fns.forEach((fn) => fn())
    },
  }
}

// ---------- 假请求（duck typing，避开 navigate 模式不能构造的限制） ----------

const req = ({ url, method = 'GET', mode = 'cors', headers = {}, destination = '' }) => ({
  url: new URL(url, ORIGIN).toString(),
  method,
  mode,
  destination,
  headers: new Headers(headers),
})

// ---------- 装载 sw.js ----------

function loadSW(routes = {}, { seedCaches = [] } = {}) {
  const net = makeNet(routes)
  const caches = makeCaches(net, seedCaches)
  const clock = makeClock()
  const listeners = {}
  const env = { skipped: false, claimed: false }

  const self = {
    addEventListener(type, fn) {
      ;(listeners[type] ||= []).push(fn)
    },
    skipWaiting() {
      env.skipped = true
    },
    location: { origin: ORIGIN },
    clients: {
      async claim() {
        env.claimed = true
      },
      async matchAll() {
        return []
      },
      async openWindow() {},
    },
    registration: { async showNotification() {} },
  }

  // sw.js 在真实 SW 全局里跑，这里用假 self/caches/fetch 喂给它
  new Function(
    'self',
    'caches',
    'fetch',
    'location',
    'Response',
    'URL',
    'AbortController',
    'setTimeout',
    'clearTimeout',
    SW_SOURCE,
  )(
    self,
    caches,
    net,
    self.location,
    Response,
    URL,
    AbortController,
    clock.setTimeout.bind(clock),
    clock.clearTimeout.bind(clock),
  )

  const makeEvent = (request) => {
    const e = { request, responded: false, waited: [] }
    e.respondWith = (p) => {
      e.responded = true
      e.response = Promise.resolve(p)
    }
    e.waitUntil = (p) => {
      e.waited.push(Promise.resolve(p))
    }
    return e
  }

  const dispatch = (type, event) => {
    const fns = listeners[type] || []
    expect(fns.length, `sw.js 应注册 ${type} 监听`).toBeGreaterThan(0)
    fns.forEach((fn) => fn(event))
    return event
  }

  const fetchEvent = async (request) => {
    const event = makeEvent(request)
    dispatch('fetch', event)
    if (event.responded) event.response = await event.response
    return event
  }

  return { listeners, dispatch, makeEvent, fetchEvent, net, caches, clock, env, self }
}

describe('SW · 带 hash 的构建产物走 cache-first', () => {
  it('第二次打开零网络请求，且完全不排队等网络', async () => {
    const sw = loadSW({ '/assets/index-a1b2c3d4.js': () => ok('bundle-v1') })
    const asset = req({ url: '/assets/index-a1b2c3d4.js', destination: 'script' })

    const first = await sw.fetchEvent(asset)
    expect(await first.response.text()).toBe('bundle-v1')
    expect(sw.net.calls).toEqual(['/assets/index-a1b2c3d4.js'])
    await tick() // 等 fire-and-forget 的 cache.put 落盘

    const second = await sw.fetchEvent(asset)
    expect(await second.response.text()).toBe('bundle-v1')
    expect(sw.net.calls).toHaveLength(1) // 缓存命中，没有再发请求
    expect(sw.clock.pending()).toBe(0) // 也没有创建超时定时器：压根没等网络
    expect(sw.caches._has(STATIC_CACHE, '/assets/index-a1b2c3d4.js')).toBe(true)
  })

  it('带 hash 的字体/图片同样命中缓存', async () => {
    const sw = loadSW({ '/assets/baloo2-latin-var-9f8e7d6c.woff2': () => ok('font') })
    const font = req({ url: '/assets/baloo2-latin-var-9f8e7d6c.woff2', destination: 'font' })
    await sw.fetchEvent(font)
    await tick()
    await sw.fetchEvent(font)
    expect(sw.net.calls).toHaveLength(1)
  })

  it('未命中且断网时返回 504，不把异常抛给页面', async () => {
    const sw = loadSW({})
    const res = await (await sw.fetchEvent(req({ url: '/assets/missing-deadbeef.js' }))).response
    expect(res.status).toBe(504)
  })

  it('响应带 no-store 就不会被缓存', async () => {
    const sw = loadSW({
      '/assets/index-a1b2c3d4.js': () => ok('secret', { headers: { 'cache-control': 'no-store' } }),
    })
    const asset = req({ url: '/assets/index-a1b2c3d4.js' })
    await sw.fetchEvent(asset)
    await sw.fetchEvent(asset)
    expect(sw.net.calls).toHaveLength(2)
  })
})

describe('SW · 导航（HTML）网络优先但超时回退', () => {
  it('网络快：用网络的 HTML，同时写入缓存供下次兜底', async () => {
    const sw = loadSW({ '/': () => ok('<html>fresh</html>') })
    const nav = req({ url: '/', mode: 'navigate', destination: 'document' })

    const event = await sw.fetchEvent(nav)
    expect(await event.response.text()).toBe('<html>fresh</html>')
    expect(sw.clock.pending()).toBe(0) // 定时器已清理

    await tick()
    expect(sw.caches._has(PAGES_CACHE, '/')).toBe(true)
  })

  it('网络挂住：超时后立刻回退缓存，不再干等', async () => {
    const sw = loadSW({ '/': () => ok('<html>cached</html>') })
    const nav = req({ url: '/', mode: 'navigate', destination: 'document' })
    await sw.fetchEvent(nav) // 先有一份缓存
    await tick()

    sw.net.set('/', hang) // 之后网络挂住
    const event = sw.makeEvent(nav)
    sw.dispatch('fetch', event)

    let settled = false
    event.response.then(() => {
      settled = true
    })
    await tick()
    expect(settled).toBe(false) // 还在等网络 —— 说明超时机制确实存在
    await fireTimeout(sw) // 1.5s 到点
    const res = await event.response
    expect(await res.text()).toBe('<html>cached</html>')
    expect(sw.net.calls).toHaveLength(2) // 第二次确实尝试过网络
  })

  it('install 会预热 "/"：第一次重开就有兜底，不用等一次成功的导航', async () => {
    const sw = loadSW({ '/': () => ok('<html>prewarmed</html>') })
    const install = sw.makeEvent(req({ url: '/sw.js' }))
    sw.dispatch('install', install)
    await Promise.all(install.waited)

    expect(sw.env.skipped).toBe(true)
    expect(sw.caches._has(PAGES_CACHE, '/')).toBe(true)

    sw.net.set('/', hang) // 从此断网/慢网
    const event = sw.makeEvent(req({ url: '/', mode: 'navigate' }))
    sw.dispatch('fetch', event)
    await fireTimeout(sw)
    expect(await (await event.response).text()).toBe('<html>prewarmed</html>')
  })

  it('断网且没有缓存：返回 504，页面不会拿到未处理异常', async () => {
    const sw = loadSW({ '/': hang }) // 挂住直到超时，且没有任何缓存可退
    const event = sw.makeEvent(req({ url: '/', mode: 'navigate' }))
    sw.dispatch('fetch', event)
    await fireTimeout(sw)
    expect((await event.response).status).toBe(504)
  })
})

describe('SW · 没有 hash 的源码模块不能长期钉住', () => {
  it('缓存里有旧模块时，网络仍优先 —— 发新版马上生效', async () => {
    const sw = loadSW({ '/src/App.jsx': () => ok('OLD') })
    const mod = req({ url: '/src/App.jsx', destination: 'script' })

    expect(await (await sw.fetchEvent(mod)).response.text()).toBe('OLD')
    await tick()

    sw.net.set('/src/App.jsx', () => ok('NEW'))
    expect(await (await sw.fetchEvent(mod)).response.text()).toBe('NEW')

    // 缓存也跟着更新：断网后就拿新模块，不会退回旧代码
    sw.net.set('/src/App.jsx', hang)
    const event = sw.makeEvent(mod)
    sw.dispatch('fetch', event)
    await fireTimeout(sw)
    expect(await (await event.response).text()).toBe('NEW')
    expect(sw.caches._has(STATIC_CACHE, '/src/App.jsx')).toBe(true)
  })

  it('弱网时源码模块仍能用缓存兜底（不白屏）', async () => {
    const sw = loadSW({ '/src/lib/store.jsx': () => ok('cached-module') })
    const mod = req({ url: '/src/lib/store.jsx', destination: 'script' })
    await sw.fetchEvent(mod)
    await tick()

    sw.net.set('/src/lib/store.jsx', hang)
    const event = sw.makeEvent(mod)
    sw.dispatch('fetch', event)
    await fireTimeout(sw)
    expect(await (await event.response).text()).toBe('cached-module')
  })

  it('图标这类无 hash 的同源资源也不被长期钉住', async () => {
    const sw = loadSW({ '/icons/icon-192.png': () => ok('icon-v1') })
    const icon = req({ url: '/icons/icon-192.png', destination: 'image' })
    await sw.fetchEvent(icon)
    await tick()
    sw.net.set('/icons/icon-192.png', () => ok('icon-v2'))
    expect(await (await sw.fetchEvent(icon)).response.text()).toBe('icon-v2')
  })
})

describe('SW · 这些请求一律不接管', () => {
  it('跨域（Supabase 等）直连', async () => {
    const sw = loadSW({})
    const event = await sw.fetchEvent(req({ url: 'https://xyz.supabase.co/rest/v1/couples' }))
    expect(event.responded).toBe(false)
  })

  it('带 Range 的请求（音视频拖动）直连', async () => {
    const sw = loadSW({})
    const event = await sw.fetchEvent(req({ url: '/assets/movie-abcdef12.mp4', headers: { range: 'bytes=0-1023' } }))
    expect(event.responded).toBe(false)
  })

  it('非 GET 直连', async () => {
    const sw = loadSW({})
    const event = await sw.fetchEvent(req({ url: '/rest/v1/photos', method: 'POST' }))
    expect(event.responded).toBe(false)
  })

  it('sw.js 自己不进缓存（否则永远升不了级）', async () => {
    const sw = loadSW({})
    const event = await sw.fetchEvent(req({ url: '/sw.js', destination: 'serviceworker' }))
    expect(event.responded).toBe(false)
  })
})

describe('SW · 缓存版本号 + 升级清理', () => {
  it('activate 删掉所有非当前版本的缓存', async () => {
    const sw = loadSW({}, { seedCaches: ['love-cache-v2', 'love-static-v1', 'love-pages-v2', STATIC_CACHE, PAGES_CACHE] })
    const event = sw.makeEvent(req({ url: '/sw.js' }))
    sw.dispatch('activate', event)
    await Promise.all(event.waited)

    const keys = await sw.caches.keys()
    expect(keys.sort()).toEqual([PAGES_CACHE, STATIC_CACHE].sort())
    expect(sw.env.claimed).toBe(true)
  })

  it('sw.js 的缓存名带 VERSION，改版本号即换命名空间', () => {
    expect(SW_SOURCE).toMatch(/const VERSION = 'v\d+'/)
    expect(SW_SOURCE).toContain('love-static-${VERSION}')
    expect(SW_SOURCE).toContain('love-pages-${VERSION}')
  })

  it('推送与通知点击监听没被缓存改造带歪', () => {
    expect(SW_SOURCE).toContain("addEventListener('push'")
    expect(SW_SOURCE).toContain("addEventListener('notificationclick'")
  })
})
