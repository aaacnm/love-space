// 批量保存冒烟：与批量删除共用选择模式
// A. Android：静默逐张下载（原图优先），进度后提示
// B. iPhone：逐张确认弹窗（share 每次要手势），完成态可关闭
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tick = (ms = 30) => sleep(ms)
function waitFor(fn, name, tries = 60) {
  return new Promise((resolve) => {
    const go = async (n) => {
      if (fn()) return resolve(true)
      if (n <= 0) {
        failures.push('waitFor: ' + name)
        console.log('  ✗ waitFor 超时:', name)
        return resolve(false)
      }
      await tick(25)
      go(n - 1)
    }
    go(tries)
  })
}

// ---------- 内存库 / supabase stub（同 photos-fix 结构） ----------
const db = { photos: [], albums: [], delete_requests: [] }
const TODAY = new Date()
const iso = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0, 0).toISOString()

db.photos = [
  // 都带 thumb_path：没有缩略图的旧照片会触发后台补齐（多 2 次 fetch 下载 blob），
  // 本用例只统计「保存」产生的请求，所以 fixture 按「已补齐」的新常态来
  { id: 'p1', couple_id: 'c1', author_user_id: 'u1', storage_path: 'photos/c1/a.jpg', thumb_path: 'thumbs/c1/a.jpg', original_path: 'originals/c1/a.jpg', caption: '第一张', created_at: iso(TODAY) },
  { id: 'p2', couple_id: 'c1', author_user_id: 'u2', storage_path: 'photos/c1/b.jpg', thumb_path: 'thumbs/c1/b.jpg', original_path: null, caption: '第二张', created_at: iso(TODAY) },
]

const match = (row, filters) => filters.every((f) => (f.op === 'eq' ? row[f.col] === f.val : Array.isArray(f.val) && f.val.includes(row[f.col])))
function makeQuery(table) {
  let op = null
  let rowsArg = null
  let patch = null
  const filters = []
  let orderCfg = null
  const q = {
    select() {
      if (op !== 'insert') op = 'select'
      return q
    },
    insert(rows) { op = 'insert'; rowsArg = rows; return q },
    update(p) { op = 'update'; patch = p; return q },
    delete() { op = 'delete'; return q },
    eq(col, val) { filters.push({ col, op: 'eq', val }); return q },
    in(col, vals) { filters.push({ col, op: 'in', val: vals }); return q },
    order(col, cfg) { orderCfg = { col, ...cfg }; return q },
    range() { return q },
    is(col, val) { filters.push({ col, op: 'eq', val }); return q },
    single() { return q },
  }
  q.then = (onFul, onRej) => run().then(onFul, onRej)
  async function run() {
    if (op === 'select') {
      let out = db[table].filter((r) => match(r, filters))
      if (orderCfg) {
        const dir = orderCfg.ascending ? 1 : -1
        out = [...out].sort((a, b) => (a[orderCfg.col] > b[orderCfg.col] ? dir : -dir))
      }
      return { data: structuredClone(out), error: null }
    }
    if (op === 'insert') {
      const arr = Array.isArray(rowsArg) ? rowsArg : [rowsArg]
      const inserted = arr.map((r) => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }))
      db[table].push(...inserted)
      return { data: null, error: null }
    }
    if (op === 'update') {
      db[table].forEach((r) => { if (match(r, filters)) Object.assign(r, patch) })
      return { data: null, error: null }
    }
    if (op === 'delete') {
      db[table] = db[table].filter((r) => !match(r, filters))
      return { data: null, error: null }
    }
    return { data: null, error: null }
  }
  return q
}

const shareCalls = []
const supabase = {
  from: (t) => makeQuery(t),
  storage: {
    from: () => ({
      upload: async () => ({ data: {}, error: null }),
      remove: async () => ({ data: [], error: null }),
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
globalThis.__SUPABASE_STUB__ = supabase
globalThis.__ME = { id: 'u1' }
globalThis.__MEMBERS = [
  { id: 'm1', user_id: 'u1', nickname: '我', emoji: '💕' },
  { id: 'm2', user_id: 'u2', nickname: 'TA', emoji: '🐰' },
]

// ---------- jsdom ----------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const { window } = dom
for (const k of ['window', 'document', 'localStorage', 'CustomEvent', 'location', 'requestAnimationFrame', 'getComputedStyle', 'MutationObserver']) {
  if (window[k] !== undefined) globalThis[k] = window[k]
}
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
const setUA = (ua) => {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
}

// fetch / createObjectURL / a.click stub
const fetchCalls = []
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url))
  return { ok: true, blob: async () => new window.Blob(['x'], { type: 'image/jpeg' }) }
}
const objectUrls = []
window.URL.createObjectURL = (b) => {
  objectUrls.push(b)
  return 'blob:fake-' + objectUrls.length
}
window.URL.revokeObjectURL = () => {}
window.HTMLAnchorElement.prototype.click = function () {}

const bodyText = () => document.body.textContent
const lastModal = () => {
  const ms = [...document.querySelectorAll('div.fixed.inset-0')]
  return ms[ms.length - 1] || null
}
const clickByText = (text, scope = document) => {
  const b = [...scope.querySelectorAll('button')].find((x) => x.textContent.replace(/\s/g, '').includes(text))
  if (b) b.click()
  return !!b
}

// ---------- bundle ----------
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'batch-save.bundle.cjs')
await esbuild.build({
  entryPoints: ['D:/love/src/views/Photos.jsx'],
  bundle: true,
  format: 'cjs',
  jsx: 'automatic',
  platform: 'node',
  packages: 'external',
  define: { 'import.meta.env': '{}' },
  outfile: out,
  plugins: [
    {
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /supabase\.js$/ }, () => ({ path: 'supa-stub', namespace: 'stub' }))
        b.onResolve({ filter: /store\.jsx$/ }, () => ({ path: 'store-stub', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents:
            args.path === 'supa-stub'
              ? 'export const supabase = globalThis.__SUPABASE_STUB__'
              : 'export function StoreProvider({ children }) { return children }\nexport function useStore() { return { coupleId: "c1", user: globalThis.__ME, members: globalThis.__MEMBERS } }',
          loader: 'js',
        }))
      },
    },
  ],
})

const React = require('react')
const ReactDomClient = require('react-dom/client')
const Photos = require(out).default
const root = ReactDomClient.createRoot(document.getElementById('root'))
const mount = () => root.render(React.createElement(Photos))

const enterSelectAndPick = async () => {
  ok(clickByText('选择'), '进入选择模式')
  await tick(60)
  // 只点网格照片卡（祖先有 draggable 层）；图集 chip 的封面 img 冒泡会触发 switchView 把选择模式关掉
  ;[...document.querySelectorAll('img')]
    .filter((im) => im.closest('div[draggable]'))
    .forEach((im) => im.closest('div[draggable]').click())
  await tick(60)
}

console.log('\n场景 A：Android 静默批量下载（原图优先）')
setUA('Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile')
mount()
await waitFor(() => bodyText().includes('张照片'), '照片网格渲染')
await enterSelectAndPick()
ok(bodyText().includes('已选 2'), '已选中 2 张')
ok(clickByText('保存'), '点「⬇ 保存」')
await waitFor(() => bodyText().includes('已保存 2 张'), '完成提示')
ok(fetchCalls.length === 2, `静默下载了 2 张（fetch ${fetchCalls.length}/2）`)
ok(fetchCalls.some((u) => u.includes('originals/c1/a.jpg')), '有原图的照片用 original_path')
ok(fetchCalls.some((u) => u.includes('photos/c1/b.jpg') && !u.includes('originals')), '无原图的照片回退 storage_path')
root.unmount()
await tick(60)

console.log('\n场景 B：iPhone 逐张确认保存')
fetchCalls.length = 0
shareCalls.length = 0
setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
window.navigator.canShare = ({ files }) => files && files.length > 0
window.navigator.share = async (data) => {
  shareCalls.push(data)
  return 'ok'
}
document.body.innerHTML = '<div id="root"></div>'
const root2 = ReactDomClient.createRoot(document.getElementById('root'))
root2.render(React.createElement(Photos))
await waitFor(() => bodyText().includes('张照片'), '重新渲染')
ok(clickByText('选择'), '进入选择模式')
await tick(60)
;[...document.querySelectorAll('img')]
  .filter((im) => im.closest('div[draggable]'))
  .forEach((im) => im.closest('div[draggable]').click())
await tick(60)
ok(clickByText('保存'), '点「⬇ 保存」')
await waitFor(() => bodyText().includes('保存照片 1/2'), 'iOS 弹窗出现 1/2')
let modal = lastModal()
ok(!!modal && modal.textContent.includes('存储到照片'), '有「存储到照片」按钮')
clickByText('存储到照片', modal)
await tick(200)
ok(shareCalls.length === 1 && shareCalls[0].files?.length === 1, '第一次 share 调起（文件 1 张）')
await waitFor(() => bodyText().includes('保存照片 2/2'), '自动到 2/2')
modal = lastModal()
clickByText('存储到照片', modal)
await tick(200)
await waitFor(() => bodyText().includes('完成！已保存 2 张'), '完成态')
ok(shareCalls.length === 2, '共 2 次 share（每张都有手势）')
modal = lastModal()
clickByText('好的', modal)
await tick(80)
ok(!bodyText().includes('完成！已保存'), '弹窗已关闭')
root2.unmount()
await tick(40)

console.log(`\n========== 结果：${pass} 通过 / ${failures.length} 失败 ==========`)
if (failures.length) {
  failures.forEach((f) => console.log(' -', f))
  process.exit(1)
}
