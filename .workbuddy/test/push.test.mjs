// Web Push 订阅（src/lib/push.js）+ sw.js 推送监听的冒烟测试
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
const failures = []
const ok = (cond, name) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    failures.push(name)
    console.log('  ✗', name)
  }
}

// ---------- jsdom ----------
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const { window } = dom
globalThis.window = window
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.HTMLElement = window.HTMLElement

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- supabase stub ----------
const dbLog = { upserts: [], deletes: [] }
let upsertError = null
globalThis.__SUPA__ = {
  from(table) {
    return {
      upsert(payload, opts) {
        dbLog.upserts.push({ table, payload, opts })
        return Promise.resolve({ error: upsertError })
      },
      delete() {
        return {
          eq(col, val) {
            dbLog.deletes.push({ col, val })
            return Promise.resolve({ error: null })
          },
        }
      },
    }
  },
}
const supaStub = `export const supabase = globalThis.__SUPA__`

// ---------- SW / PushManager / Notification stubs ----------
const unsubLog = []
const subOptsLog = []
class FakeSub {
  constructor(endpoint) {
    this.endpoint = endpoint
  }
  toJSON() {
    return { endpoint: this.endpoint, keys: { p256dh: 'k-p256dh', auth: 'k-auth' } }
  }
  async unsubscribe() {
    unsubLog.push(this.endpoint)
  }
}
let regRef = {
  pushManager: {
    _sub: null,
    async getSubscription() {
      return this._sub
    },
    async subscribe(opts) {
      subOptsLog.push(opts)
      this._sub = new FakeSub('https://push.example/abc')
      return this._sub
    },
  },
}
const swStub = {
  getRegistration: async () => regRef,
  register: async () => regRef,
}
Object.defineProperty(window.navigator, 'serviceWorker', { value: swStub, configurable: true })
Object.defineProperty(globalThis.navigator, 'serviceWorker', { value: swStub, configurable: true })

let notifPerm = 'default'
let requestResult = 'granted'
let requestCalls = 0
function installNotification() {
  window.Notification = {
    get permission() {
      return notifPerm
    },
    requestPermission: async () => {
      requestCalls++
      notifPerm = requestResult
      return requestResult
    },
  }
}
installNotification()

// ---------- esbuild 打包 ----------
const here = path.dirname(fileURLToPath(import.meta.url))
async function bundle(entry, outfile) {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    packages: 'external',
    outfile,
    logLevel: 'silent',
    plugins: [
      {
        name: 'supa-stub',
        setup(b) {
          b.onResolve({ filter: /supabase\.js$/ }, () => ({ path: 'supa-stub', namespace: 'stub' }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: supaStub, loader: 'js' }))
        },
      },
    ],
  })
  return require(outfile)
}

const push = await bundle('D:/love/src/lib/push.js', path.join(here, 'push-unit.bundle.cjs'))

// ============================================================
console.log('\n场景组 1：能力检测与状态机')

{
  // 1a. 无 PushManager → unsupported
  ok(push.pushSupported() === false, '无 PushManager 时判定不支持')
  ok((await push.pushState()) === 'unsupported', '状态：unsupported')

  // 1b. 补上 PushManager → 状态随权限/订阅变化
  window.PushManager = function PushManagerFake() {}
  ok(push.pushSupported() === true, '有 SW + PushManager + Notification 判定支持')

  regRef = null
  ok((await push.pushState()) === 'unsubscribed', '无注册 → unsubscribed')

  regRef = { pushManager: { async getSubscription() { return null } } }
  ok((await push.pushState()) === 'unsubscribed', '有注册无订阅 → unsubscribed')

  notifPerm = 'denied'
  ok((await push.pushState()) === 'denied', '权限被拒 → denied（不问订阅）')

  notifPerm = 'granted'
  regRef = { pushManager: { async getSubscription() { return new FakeSub('https://push.example/live') } } }
  ok((await push.pushState()) === 'subscribed', '有订阅 → subscribed')
}

// ============================================================
console.log('\n场景组 2：enablePush 授权订阅')

{
  // 2a. default → 弹授权（granted）→ subscribe → 入库
  notifPerm = 'default'
  requestResult = 'granted'
  subOptsLog.length = 0
  dbLog.upserts.length = 0
  regRef = {
    pushManager: {
      _sub: null,
      async getSubscription() { return this._sub },
      async subscribe(opts) { subOptsLog.push(opts); this._sub = new FakeSub('https://push.example/new'); return this._sub },
    },
  }
  const r = await push.enablePush('u1')
  await sleep(10)
  ok(r.state === 'subscribed' && r.ok === true, '授权+订阅成功')
  ok(requestCalls === 1, '权限为 default 时弹了一次授权')
  ok(subOptsLog.length === 1 && subOptsLog[0].userVisibleOnly === true, 'subscribe 带 userVisibleOnly')
  const key = subOptsLog[0].applicationServerKey
  ok(key instanceof Uint8Array && key.length === 65, `applicationServerKey 是 65 字节 P-256 公钥（实际 ${key && key.length}）`)
  ok(dbLog.upserts.length === 1, '订阅登记到 push_subscriptions')
  const up = dbLog.upserts[0]
  ok(
    up.payload.user_id === 'u1' &&
      up.payload.endpoint === 'https://push.example/new' &&
      up.payload.p256dh === 'k-p256dh' &&
      up.payload.auth === 'k-auth',
    '登记内容：user_id/endpoint/p256dh/auth',
  )
  ok(up.opts && up.opts.onConflict === 'endpoint', '按 endpoint 幂等 upsert')

  // 2b. 已有订阅 → 不重复 subscribe，仍刷新登记
  subOptsLog.length = 0
  dbLog.upserts.length = 0
  const r2 = await push.enablePush('u1')
  ok(r2.ok === true && subOptsLog.length === 0 && dbLog.upserts.length === 1, '已有订阅：复用不重订，登记刷新')

  // 2c. 用户拒绝 → 不订阅不入库
  notifPerm = 'default'
  requestResult = 'denied'
  subOptsLog.length = 0
  dbLog.upserts.length = 0
  const r3 = await push.enablePush('u1')
  ok(r3.state === 'denied' && r3.ok === false && subOptsLog.length === 0 && dbLog.upserts.length === 0, '拒绝授权：不订阅')

  // 2d. 入库报错 → ok=false 但订阅本体仍在
  notifPerm = 'granted'
  upsertError = { message: 'rls blocked' }
  dbLog.upserts.length = 0
  const r4 = await push.enablePush('u1')
  ok(r4.ok === false && r4.state === 'subscribed', '入库失败如实上报 ok=false')
  upsertError = null

  // 2e. 不支持的环境 → unsupported
  const savedPM = window.PushManager
  delete window.PushManager
  const r5 = await push.enablePush('u1')
  ok(r5.state === 'unsupported', '无 PushManager（iOS 未加主屏）→ unsupported')
  window.PushManager = savedPM
}

// ============================================================
console.log('\n场景组 3：healPush 自愈 / disablePush 退订')

{
  // 3a. 已授权 + 有订阅 → 刷新登记（iOS 静默掉订阅的自愈路径）
  notifPerm = 'granted'
  dbLog.upserts.length = 0
  let sub = new FakeSub('https://push.example/live')
  regRef = { pushManager: { async getSubscription() { return sub } } }
  await push.healPush('u1')
  await sleep(10)
  ok(dbLog.upserts.length === 1 && dbLog.upserts[0].payload.endpoint === 'https://push.example/live', '已授权有订阅 → 补登记')

  // 3b. 未授权 → 完全静默
  notifPerm = 'default'
  dbLog.upserts.length = 0
  await push.healPush('u1')
  await sleep(10)
  ok(dbLog.upserts.length === 0, '未授权 → 不弹框不登记')

  // 3c. 无 userId → no-op
  await push.healPush(null)
  ok(dbLog.upserts.length === 0, '无 userId → no-op')

  // 3d. disablePush：退订 + 删登记
  dbLog.deletes.length = 0
  await push.disablePush('u1')
  await sleep(10)
  ok(unsubLog.includes('https://push.example/live'), '退订浏览器订阅')
  ok(dbLog.deletes.length === 1 && dbLog.deletes[0].col === 'user_id' && dbLog.deletes[0].val === 'u1', '删除该用户全部登记')
}

// ============================================================
console.log('\n场景组 4：sw.js 推送监听（源码断言）')

{
  const fs = await import('node:fs')
  const sw = fs.readFileSync('D:/love/public/sw.js', 'utf8')
  ok(sw.includes("addEventListener('push'"), 'sw.js 注册了 push 事件')
  ok(sw.includes("visibilityState === 'visible'"), '前台可见时吞掉推送（防双重打扰）')
  ok(sw.includes("showNotification"), '推送落地为系统通知')
  ok(sw.includes("notificationclick"), '点击通知唤回 App 的处理仍在')
}

// ============================================================
console.log(`\n结果: ${pass} 通过, ${failures.length} 失败`)
if (failures.length) {
  console.log('失败项:')
  failures.forEach((f) => console.log('  ✗', f))
  process.exit(1)
}
