/**
 * 照片删除三项修复的 jsdom 冒烟测试
 *   1. 彻底删除 = 个人行为：回收站里直接真删，不再发 delete_requests
 *   2. 收到申请删除不重复弹出：respond 后旧数据窗口内不再重弹（seenRef）
 *   3. 申请删除信息持久：叉掉提醒弹窗后，页面常驻「待你确认」条目可随时重新打开
 * 附回归：发起删除仍走双方同意、对方同意后软删除进回收站。
 * 附数据一致性回归：批准走 approve_delete_request RPC 事务（失败提示 + 原状可重试）、
 *   入库失败 rollbackUploads 统一撤回（浏览图/原图/缩略图）、恢复/彻底删除/撤回失败如实提示。
 *
 * 用法：NODE_PATH=<workspace>/node_modules node photos-fix.test.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')
import fs from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

// ---------- jsdom 环境 ----------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true })
global.HTMLElement = dom.window.HTMLElement
global.HTMLInputElement = dom.window.HTMLInputElement
global.Node = dom.window.Node
global.Event = dom.window.Event
global.KeyboardEvent = dom.window.KeyboardEvent
global.CustomEvent = dom.window.CustomEvent
global.getComputedStyle = dom.window.getComputedStyle
global.requestAnimationFrame = (cb) => setTimeout(cb, 0)
global.cancelAnimationFrame = (id) => clearTimeout(id)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tick = (ms = 10) => sleep(ms)

// ---------- 内存数据库 / supabase stub ----------
const db = { photos: [], albums: [], delete_requests: [] }
const bucket = {}
let selectDelay = 25 // select 模拟网络延迟：制造 respond 后的「旧数据窗口」

const match = (row, filters) =>
  filters.every((f) => (f.op === 'eq' ? row[f.col] === f.val : Array.isArray(f.val) && f.val.includes(row[f.col])))

function makeQuery(table) {
  let op = null
  let rowsArg = null
  let patch = null
  const filters = []
  let orderCfg = null
  let wantSingle = false
  const q = {
    select() {
      if (op !== 'insert') op = 'select'
      return q
    },
    insert(rows) {
      op = 'insert'
      rowsArg = rows
      return q
    },
    update(p) {
      op = 'update'
      patch = p
      return q
    },
    delete() {
      op = 'delete'
      return q
    },
    eq(col, val) {
      filters.push({ col, op: 'eq', val })
      return q
    },
    in(col, vals) {
      filters.push({ col, op: 'in', val: vals })
      return q
    },
    order(col, cfg) {
      orderCfg = { col, ...cfg }
      return q
    },
    // usePagedCollection 的分页窗口 / exportAlbum 的软删过滤：stub 不真正分页（数据量 < 页大小）
    range() {
      return q
    },
    is(col, val) {
      filters.push({ col, op: 'eq', val })
      return q
    },
    single() {
      wantSingle = true
      return q
    },
  }
  q.then = (onFul, onRej) => run().then(onFul, onRej)
  async function run() {
    if (op === 'select') {
      await sleep(selectDelay)
      let out = db[table].filter((r) => match(r, filters))
      if (orderCfg) {
        const dir = orderCfg.ascending ? 1 : -1
        out = [...out].sort((a, b) => (a[orderCfg.col] > b[orderCfg.col] ? dir : -dir))
      }
      return { data: structuredClone(out), error: null }
    }
  if (op === 'insert') {
    if (globalThis.__FAIL_INSERT__) return { data: null, error: globalThis.__FAIL_INSERT__ }
    const arr = Array.isArray(rowsArg) ? rowsArg : [rowsArg]
      if (process.env.DEBUG_INSERT) console.log('INSERT', table, JSON.stringify(arr), '__ME=', JSON.stringify(globalThis.__ME))
      // 真 Supabase 会由数据库补 id/created_at 默认值，stub 同样补上（否则 key={row.id} 缺失）
      const inserted = arr.map((r) => {
        const clean = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined))
        return { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...clean }
      })
      db[table].push(...inserted)
      if (wantSingle) return { data: inserted[0] || null, error: null }
      return { data: null, error: null }
    }
    if (op === 'update') {
      if (globalThis.__FAIL_UPDATE__) return { data: null, error: globalThis.__FAIL_UPDATE__ }
      updateLog.push({ table, patch })
      db[table].forEach((r) => {
        if (match(r, filters)) Object.assign(r, patch)
      })
      return { data: null, error: null }
    }
    if (op === 'delete') {
      if (globalThis.__FAIL_DELETE__) return { data: null, error: globalThis.__FAIL_DELETE__ }
      db[table] = db[table].filter((r) => !match(r, filters))
      return { data: null, error: null }
    }
    return { data: null, error: null }
  }
  return q
}

const supabase = {
  from: (t) => makeQuery(t),
  // approve_delete_request RPC：与真迁移同语义（事务内软删 + 状态更新 + 幂等），
  // rpcFail 注入失败用来测「批准失败」的提示路径
  rpc: async (name, args) => {
    rpcLog.push({ name, args })
    if (rpcFail) return { data: null, error: rpcFail }
    if (name !== 'approve_delete_request') return { data: null, error: null }
    const row = db.delete_requests.find((r) => r.id === args.p_request_id)
    if (!row) return { data: null, error: { message: '删除请求不存在（可能已被撤回）' } }
    if (row.requester_user_id === globalThis.__ME?.id) {
      return { data: null, error: { message: '不能批准自己发起的请求' } }
    }
    if (row.status === 'approved') return { data: null, error: null } // 幂等
    if (row.status !== 'pending') return { data: null, error: { message: '该请求已被处理（当前状态：' + row.status + '）' } }
    const nowIso = new Date().toISOString()
    if (row.kind === 'album') {
      db.photos.forEach((p) => {
        if (row.ref_ids.includes(p.album_id)) p.album_id = null
      })
      db.albums.forEach((a) => {
        if (row.ref_ids.includes(a.id) && !a.deleted_at) {
          a.deleted_at = nowIso
          a.deleted_by = globalThis.__ME?.id
        }
      })
    } else {
      db.photos.forEach((p) => {
        if (row.ref_ids.includes(p.id) && !p.deleted_at) {
          p.deleted_at = nowIso
          p.deleted_by = globalThis.__ME?.id
        }
      })
    }
    row.status = 'approved'
    row.responder_user_id = globalThis.__ME?.id
    row.resolved_at = nowIso
    return { data: null, error: null }
  },
  storage: {
    from: () => ({
      upload: async (p) => {
        bucket[p] = { size: 10 }
        return { data: { path: p }, error: null }
      },
      remove: async (paths) => {
        removeLog.push(...paths)
        if (removeFail) return { data: null, error: removeFail }
        paths.forEach((p) => delete bucket[p])
        return { data: paths.map((p) => ({ name: p })), error: null }
      },
      getPublicUrl: (p) => ({ data: { publicUrl: `http://img.test/${p}` } }),
      createSignedUrl: async (p, _t) => ({ data: { signedUrl: 'http://img.test/sign/' + p }, error: null }),
      createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: 'http://img.test/sign/' + p })), error: null }),
    }),
  },
  channel: () => {
    const ch = { on() { return ch }, subscribe() { return ch } }
    return ch
  },
  removeChannel() {},
  auth: {
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    getSession: async () => ({ data: { session: null } }),
  },
}

// rpc / storage.remove / update / delete 的调用记录与失败注入（场景里按需开关）
let rpcLog = []
let rpcFail = null
let removeLog = []
let removeFail = null
let updateLog = []
const resetLogs = () => {
  rpcLog = []
  removeLog = []
  rpcFail = null
  removeFail = null
  updateLog = []
  globalThis.__FAIL_INSERT__ = null
  globalThis.__FAIL_UPDATE__ = null
  globalThis.__FAIL_DELETE__ = null
  clearToasts() // 提示是模块级单例，跨场景会残留，每个场景开场清屏
}

// 统一提示（Toast）：错误/警告/成功都渲染成 [data-toast-item]，不再是 alert。
// 组件 bundle 不挂 ToastProvider 时，toast 模块会兜底渲染到 document.body，所以直接查 DOM。
const toastTexts = () => [...document.querySelectorAll('[data-toast-item]')].map((el) => el.textContent || '')
const clearToasts = () => globalThis.__TOAST__ && globalThis.__TOAST__.clear()

const supabaseStubSource = 'export const supabase = globalThis.__SUPABASE_STUB__'
const storeStubSource = `
export function StoreProvider({ children }) { return children }
export function useStore() {
  return { coupleId: 'c1', user: globalThis.__ME, members: globalThis.__MEMBERS }
}
`

// ---------- 打包 Photos.jsx（bare import 一律 external，运行时与外层共用同一份 React） ----------
const plugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.path.endsWith('supabase.js')) return { path: 'supa-stub', namespace: 'stub' }
      if (args.path.endsWith('store.jsx')) return { path: 'store-stub', namespace: 'stub' }
      return null
    })
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: args.path === 'supa-stub' ? supabaseStubSource : storeStubSource,
      loader: 'js',
    }))
  },
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'photos-fix.bundle.cjs')
await esbuild.build({
  entryPoints: ['D:/love/src/views/Photos.jsx'],
  bundle: true,
  write: true,
  format: 'cjs',
  jsx: 'automatic',
  platform: 'node',
  packages: 'external',
  define: { 'import.meta.env': '{}' },
  plugins: [plugin],
  outfile: out,
})

globalThis.__SUPABASE_STUB__ = supabase
const Photos = require(out).default
const rollbackUploads = require(out).rollbackUploads // 孤儿文件统一撤回（场景 H 直接单测）

// ---------- React 渲染（与 bundle 同源：都从 D:/love/node_modules 解析） ----------
const ReactDomClient = require('react-dom/client')
const ReactCore = require('react')

const MEMBERS = [
  { user_id: 'u1', nickname: '我' },
  { user_id: 'u2', nickname: '宝贝' },
]
globalThis.__MEMBERS = MEMBERS

let root = null
async function mount(me) {
  if (root) {
    root.unmount()
    await tick(30)
  }
  globalThis.__ME = { id: me } // auth user 形状（组件读 user.id）；成员行才是 { user_id }
  const container = document.getElementById('root')
  container.innerHTML = ''
  root = ReactDomClient.createRoot(container)
  root.render(ReactCore.createElement(Photos))
  await waitFor(() => document.querySelector('[draggable="true"]') || bodyText().includes('没有'), 'photos rendered')
  await tick(40)
}

const bodyText = () => document.body.textContent || ''
const modals = () => [...document.querySelectorAll('div.fixed.inset-0')]
const lastModal = () => modals()[modals().length - 1]

function clickByText(text, scope = document, { exact = false, idx = 'last' } = {}) {
  const els = [...scope.querySelectorAll('button, [role="button"], div, span')]
    .filter((el) => {
      const t = (el.textContent || '').trim()
      return exact ? t === text : t.includes(text)
    })
    // 只取最内层（不再包含同文本的子元素），避免点到外层容器
    .filter((el) => ![...el.querySelectorAll('*')].some((c) => ((c.textContent || '').trim().includes(text))))
  if (els.length === 0) throw new Error(`clickByText 找不到「${text}」`)
  const el = idx === 'last' ? els[els.length - 1] : els[0]
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  return el
}

async function waitFor(fn, label, timeout = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      if (fn()) return
    } catch {}
    await tick(10)
  }
  throw new Error('waitFor 超时: ' + label)
}

// ---------- 断言 ----------
let pass = 0
const failures = []
function ok(cond, msg) {
  if (cond) {
    pass++
    console.log('  ✓', msg)
  } else {
    failures.push(msg)
    console.log('  ✗', msg)
  }
}

// ---------- 造数据 ----------
const now = Date.now()
const iso = (offset) => new Date(now - offset).toISOString()
function photo(id, path, orig, caption, author, deletedAt = null, thumb = null) {
  return { id, couple_id: 'c1', author_user_id: author, storage_path: path, original_path: orig, thumb_path: thumb, caption, album_id: null, created_at: iso(0), deleted_at: deletedAt, deleted_by: null }
}
function req(id, kind, refIds, requester, status) {
  return { id, couple_id: 'c1', kind, ref_ids: refIds, label: null, purge: false, requester_user_id: requester, status, responder_user_id: null, resolved_at: null, created_at: iso(0) }
}

function resetDb() {
  db.photos = [
    photo('p1', 'photos/c1/a.jpg', 'originals/c1/a.jpg', '合照', 'u2', null, 'thumbs/c1/a.jpg'),
    photo('p2', 'photos/c1/b.jpg', null, '日常', 'u1'),
  ]
  db.albums = []
  db.delete_requests = [req('r1', 'photo', ['p1'], 'u2', 'pending')]
  Object.keys(bucket).forEach((k) => delete bucket[k])
  bucket['photos/c1/a.jpg'] = { size: 1 }
  bucket['originals/c1/a.jpg'] = { size: 1 }
  bucket['thumbs/c1/a.jpg'] = { size: 1 }
  bucket['photos/c1/b.jpg'] = { size: 1 }
}

// ================= 场景 A：弹窗持久 + 不重复自动弹 =================
console.log('\n场景 A：提醒弹窗叉掉后有常驻入口，且不会重复自动弹')
resetDb()
await mount('u1')

await waitFor(() => lastModal() && lastModal().textContent.includes('需要你确认'), '自动弹确认框')
ok(true, '有待确认请求时自动弹出「需要你确认」')

clickByText('✕', lastModal())
await tick(30)
ok(modals().length === 0, '点 ✕ 关闭提醒弹窗')

ok(bodyText().includes('等你确认') && bodyText().includes('去确认'), '页面上常驻「申请删除…等你确认」条目（无需刷新）')

await tick(150)
ok(modals().length === 0, '叉掉后不会重复自动弹出')

clickByText('去确认')
await waitFor(() => lastModal() && lastModal().textContent.includes('需要你确认'), '从常驻条重新打开')
ok(true, '点「去确认」可重新打开确认弹窗')

// ================= 场景 B：同意后不重弹（旧数据窗口） =================
console.log('\n场景 B：同意后，请求列表刷新前的旧数据不会让弹窗重新弹出')
clickByText('同意删除', lastModal())
await tick(5) // selectDelay=25ms：此刻 reqRows 仍是 r1=pending 的旧数据
ok(modals().length === 0, '同意后弹窗关闭，旧数据窗口内不重弹')
await tick(250)

ok((db.photos.find((p) => p.id === 'p1') || {}).deleted_at, '同意后 p1 软删除（进最近删除 30 天）')
ok(db.delete_requests[0].status === 'approved', '请求状态置为 approved')
ok(!bodyText().includes('等你确认'), '处理完后常驻条消失')

// ================= 场景 C：回收站彻底删除 = 个人行为 =================
console.log('\n场景 C：彻底删除不需要 TA 同意，直接真删（不发请求）')
await mount('u1') // remount：r1 已 approved，不应再自动弹
await tick(120)
ok(modals().length === 0, '已处理的请求 remount 后不再自动弹')

clickByText('最近删除', document, { exact: false, idx: 0 })
await waitFor(() => lastModal() && lastModal().textContent.includes('最近删除'), '回收站打开')
ok(bodyText().includes('合照'), '回收站里能看到刚删除的 p1')

clickByText('彻底删除', lastModal())
await waitFor(() => modals().length >= 2 && modals()[modals().length - 1].textContent.includes('无法恢复'), '二次确认弹窗')
ok(true, '点「彻底删除」先弹二次确认')
ok(db.delete_requests.length === 1, '彻底删除不发 delete_requests（个人行为）')

clickByText('彻底删除', modals()[modals().length - 1])
await tick(150)
ok(!db.photos.some((p) => p.id === 'p1'), '确认后 p1 从数据库真正删除')
ok(
  !bucket['photos/c1/a.jpg'] && !bucket['originals/c1/a.jpg'] && !bucket['thumbs/c1/a.jpg'],
  '浏览图、原图和缩略图三份文件一起清掉',
)
ok(db.delete_requests.length === 1, '仍然没有产生任何删除请求')
ok(lastModal() && lastModal().textContent.includes('最近删除'), '彻底删除后回收站弹窗保持打开（可继续处理剩余条目）')

// 手动叉掉回收站，给场景 D 一个干净的状态
clickByText('✕', lastModal())
await tick(120)
ok(modals().length === 0, '叉掉后回收站关闭')

// ================= 场景 D：发起删除仍走双方同意（回归） =================
console.log('\n场景 D：普通删除仍需 TA 同意，对方同意后进回收站')
// 点 p2 卡片打开大图
const card = document.querySelector('[draggable="true"]')
card.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
await waitFor(() => lastModal() && lastModal().textContent.includes('保存'), '大图打开')

clickByText('删除', lastModal())
await waitFor(() => modals().length >= 2 && modals()[modals().length - 1].textContent.includes('发给 TA'), '删除确认弹窗')
clickByText('发给 TA', modals()[modals().length - 1])
await tick(120)

const r2 = db.delete_requests.find((r) => r.id !== 'r1')
ok(r2 && r2.status === 'pending' && r2.requester_user_id === 'u1' && r2.ref_ids.includes('p2'), '发起删除生成待确认请求（发给 TA）')
ok(!(db.photos.find((p) => p.id === 'p2') || {}).deleted_at, 'TA 同意前照片不会被删')

await mount('u2')
await waitFor(() => lastModal() && lastModal().textContent.includes('需要你确认'), 'u2 收到确认弹窗')
clickByText('同意删除', lastModal())
await tick(250)
ok((db.photos.find((p) => p.id === 'p2') || {}).deleted_at, 'u2 同意后 p2 软删除进回收站')

// ================= 场景 E：同一张照片的重复申请 =================
console.log('\n场景 E：同一张照片的重复申请（同意一条后另一条自动失效；发起端防重）')
db.photos = [
  photo('p1', 'photos/c1/a.jpg', 'originals/c1/a.jpg', '合照', 'u2', null, 'thumbs/c1/a.jpg'),
  photo('p2', 'photos/c1/b.jpg', null, '日常', 'u1'),
]
db.albums = []
db.delete_requests = [
  req('r1', 'photo', ['p1'], 'u2', 'pending'),
  req('r3', 'photo', ['p1'], 'u2', 'pending'), // 模拟存量重复行
]
Object.keys(bucket).forEach((k) => delete bucket[k])
bucket['photos/c1/a.jpg'] = { size: 1 }
bucket['originals/c1/a.jpg'] = { size: 1 }
bucket['thumbs/c1/a.jpg'] = { size: 1 }
bucket['photos/c1/b.jpg'] = { size: 1 }

const confirmBtns = () => [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '去确认')
const pendingCount = () => db.delete_requests.filter((r) => r.status === 'pending').length

await mount('u1')
ok(confirmBtns().length === 2, '存量重复申请如实在页面上挂出两条')
await tick(60)
await waitFor(() => lastModal() && lastModal().textContent.includes('需要你确认'), '自动弹第一条')
clickByText('同意删除', lastModal())
await tick(280)
ok((db.photos.find((p) => p.id === 'p1') || {}).deleted_at, '同意第一条后 p1 软删除')
ok(confirmBtns().length === 0, '同一张照片的重复申请自动失效，不再挂条目')
ok(modals().length === 0, '失效后不重弹')

// 防重：对 p2 连续发起两次删除
async function requestDeleteOnce() {
  const card = document.querySelector('[draggable="true"]')
  card.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await waitFor(() => lastModal() && lastModal().textContent.includes('保存'), '大图打开')
  clickByText('删除', lastModal())
  await waitFor(() => modals().length >= 2 && modals()[modals().length - 1].textContent.includes('发给 TA'), '删除确认弹窗')
  clickByText('发给 TA', modals()[modals().length - 1])
  await tick(160)
}

await requestDeleteOnce()
const p2Pending = () => db.delete_requests.filter((r) => r.status === 'pending' && (r.ref_ids || []).includes('p2')).length
ok(p2Pending() === 1, '第一次发起生成 1 条请求（失效的存量行不算）')
await requestDeleteOnce()
ok(p2Pending() === 1, '第二次发起被防重拦截，不再生成新请求')
ok(bodyText().includes('已经发给 TA'), '发起端看到「已发给 TA」提示')

// ================= 场景 F：批准走事务化 RPC =================
console.log('\n场景 F：批准 = approve_delete_request RPC 事务（软删 + 状态更新原子完成）')
resetDb()
await mount('u1')
await waitFor(() => lastModal() && lastModal().textContent.includes('需要你确认'), '自动弹确认框')
resetLogs() // 清掉前面的记录，只统计这一次批准
clickByText('同意删除', lastModal())
await tick(250)

ok(rpcLog.length === 1 && rpcLog[0].name === 'approve_delete_request', '批准只发一次 approve_delete_request RPC（不再两步写）')
ok(rpcLog[0] && rpcLog[0].args && rpcLog[0].args.p_request_id === 'r1', 'RPC 参数带请求 id（p_request_id = r1）')
ok(updateLog.length === 0, '没有绕过 RPC 直接 update 表（事务化路径唯一）')
ok((db.photos.find((p) => p.id === 'p1') || {}).deleted_at, 'RPC 事务内 p1 软删除进最近删除')
ok(db.delete_requests[0].status === 'approved', '请求状态在同一事务内置为 approved')

// ================= 场景 G：RPC 失败 → 提示 + 原状可重试 =================
console.log('\n场景 G：RPC 失败时给出提示，请求与照片保持原样（无中间态）')
resetDb()
await mount('u1')
await waitFor(() => lastModal() && lastModal().textContent.includes('需要你确认'), '自动弹确认框')
resetLogs()
await tick(30) // 等 Toast 清屏渲染落地，再取基线（React 渲染是异步的）
const toastBase = toastTexts().length
rpcFail = { message: 'function approve_delete_request does not exist' }
clickByText('同意删除', lastModal())
await tick(250)

const gToasts = toastTexts().slice(toastBase)
ok(gToasts.some((a) => a.includes('批准失败')), '弹出「批准失败」toast')
ok(gToasts.some((a) => a.includes('migrations/031_delete_approve_rpc.sql')), '识别出 RPC 缺失，提示先执行迁移脚本')
ok(db.delete_requests[0].status === 'pending', '失败后请求仍是 pending（没有「已同意但照片还在」的中间态）')
ok(!(db.photos.find((p) => p.id === 'p1') || {}).deleted_at, '失败后照片没有被软删除')
ok(lastModal() && lastModal().textContent.includes('需要你确认'), '失败后确认弹窗保持打开，可直接重试')
resetLogs() // 解除失败注入

// ================= 场景 H：入库失败 → rollbackUploads 统一撤回（防孤儿文件） =================
console.log('\n场景 H：数据库写不进去时，本批已传文件（浏览图/原图/缩略图）统一撤回')
resetLogs()
bucket['photos/c1/x.jpg'] = { size: 1 }
bucket['originals/c1/x.jpg'] = { size: 1 }
bucket['thumbs/c1/x.jpg'] = { size: 1 }
bucket['photos/c1/y.jpg'] = { size: 1 }
bucket['thumbs/c1/y.jpg'] = { size: 1 } // y 没传原图：只有浏览图 + 缩略图

const rb1 = await rollbackUploads([
  'photos/c1/x.jpg', 'originals/c1/x.jpg', 'thumbs/c1/x.jpg',
  'photos/c1/y.jpg', 'thumbs/c1/y.jpg',
  'photos/c1/x.jpg', '', null, // 重复与空值应被去重/过滤
])
ok(rb1 && !rb1.error, 'rollbackUploads 正常完成')
ok(removeLog.length === 5, `五份文件一次批量撤回（重复/空值已去重过滤，实际 ${removeLog.length} 份）`)
ok(
  !bucket['photos/c1/x.jpg'] && !bucket['originals/c1/x.jpg'] && !bucket['thumbs/c1/x.jpg'] && !bucket['photos/c1/y.jpg'] && !bucket['thumbs/c1/y.jpg'],
  '浏览图、原图、缩略图全部清理，不留孤儿',
)

removeFail = { message: 'storage down' }
bucket['photos/c1/z.jpg'] = { size: 1 }
const rb2 = await rollbackUploads(['photos/c1/z.jpg'])
ok(removeLog.includes('photos/c1/z.jpg'), '清理失败时也如实记录了待删路径（便于排查/补删）')
ok(rb2 && rb2.error, '清理失败返回错误，由调用方记日志兜底')
ok(bucket['photos/c1/z.jpg'], '失败时文件仍在桶里（不误报已删）')
removeFail = null

// ================= 场景 I：回收站错误路径都有提示，不再静默 =================
console.log('\n场景 I：恢复 / 彻底删除 / 撤回失败时如实提示，数据保持原状')

// I-1 恢复失败 → 提示 + 条目还在，解除注入后可重试
resetDb()
db.photos = [
  photo('p1', 'photos/c1/a.jpg', 'originals/c1/a.jpg', '合照', 'u2', iso(3600000), 'thumbs/c1/a.jpg'),
  photo('p2', 'photos/c1/b.jpg', null, '日常', 'u1'),
]
db.delete_requests = [] // 别让待确认弹窗抢焦点
await mount('u1')
clickByText('最近删除', document, { exact: false, idx: 0 })
await waitFor(() => lastModal() && lastModal().textContent.includes('最近删除'), '回收站打开')
resetLogs()
await tick(30)
const toastBase1 = toastTexts().length
globalThis.__FAIL_UPDATE__ = { message: 'update boom' }
clickByText('↩ 恢复', lastModal(), { exact: true })
await tick(150)
ok(toastTexts().slice(toastBase1).some((a) => a.includes('恢复失败')), '恢复失败弹出 toast（不再静默）')
ok((db.photos.find((p) => p.id === 'p1') || {}).deleted_at, '恢复失败后照片仍在最近删除（原状可重试）')
globalThis.__FAIL_UPDATE__ = null
clickByText('↩ 恢复', lastModal(), { exact: true })
await tick(150)
ok(!((db.photos.find((p) => p.id === 'p1') || {}).deleted_at), '注入解除后重试，恢复成功')
clickByText('✕', lastModal())
await tick(120)

// I-2 彻底删除：记录删成功、文件清理失败 → 如实提示不误报
resetDb()
db.photos = [photo('p3', 'photos/c1/c.jpg', 'originals/c1/c.jpg', '旅行', 'u2', iso(7200000), 'thumbs/c1/c.jpg')]
db.delete_requests = []
Object.keys(bucket).forEach((k) => delete bucket[k])
bucket['photos/c1/c.jpg'] = { size: 1 }
bucket['originals/c1/c.jpg'] = { size: 1 }
bucket['thumbs/c1/c.jpg'] = { size: 1 }
await mount('u1')
clickByText('最近删除', document, { exact: false, idx: 0 })
await waitFor(() => lastModal() && lastModal().textContent.includes('最近删除'), '回收站打开')
resetLogs()
await tick(30)
const toastBase2 = toastTexts().length
removeFail = { message: 'storage down' }
clickByText('彻底删除', lastModal())
await waitFor(() => modals().length >= 2 && modals()[modals().length - 1].textContent.includes('无法恢复'), '二次确认弹窗')
clickByText('彻底删除', modals()[modals().length - 1])
await tick(150)
ok(!db.photos.some((p) => p.id === 'p3'), 'p3 记录已从数据库删除')
ok(bucket['photos/c1/c.jpg'] && bucket['originals/c1/c.jpg'] && bucket['thumbs/c1/c.jpg'], '文件清理失败时三份文件如实保留在桶里')
ok(toastTexts().slice(toastBase2).some((a) => a.includes('文件清理失败')), '弹出「文件清理失败」toast（不静默、不误报全成功）')
removeFail = null
clickByText('✕', lastModal())
await tick(120)

// I-3 撤回失败 → 提示 + 请求仍在，解除注入后可重试
resetDb()
db.delete_requests = [req('r9', 'photo', ['p2'], 'u1', 'pending')] // 我发起的
await mount('u1')
await tick(60)
resetLogs()
await tick(30)
const toastBase3 = toastTexts().length
globalThis.__FAIL_DELETE__ = { message: 'delete boom' }
clickByText('撤回', document, { exact: true })
await tick(150)
ok(toastTexts().slice(toastBase3).some((a) => a.includes('撤回失败')), '撤回失败弹出 toast（不再静默）')
ok(db.delete_requests.some((r) => r.id === 'r9' && r.status === 'pending'), '撤回失败后请求仍完整保留（无中间态）')
globalThis.__FAIL_DELETE__ = null
clickByText('撤回', document, { exact: true })
await tick(150)
ok(!db.delete_requests.some((r) => r.id === 'r9'), '注入解除后重试撤回，请求删除')

// ---------- 汇总 ----------
console.log(`\n========== 结果：${pass} 通过 / ${failures.length} 失败 ==========`)
if (failures.length) {
  failures.forEach((f) => console.log('FAILED:', f))
  process.exit(1)
}
