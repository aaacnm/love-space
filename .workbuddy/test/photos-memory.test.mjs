/**
 * 相册「记忆空间」升级 jsdom 冒烟测试
 *   1. 图集封面自动生成：置顶照片优先当封面，否则最新一张
 *   2. 图集时间范围 + 简介显示在信息卡上
 *   3. 网格排序：置顶浮最前，带 📌 徽标
 *   4. 时间线视图：按年月分组、新的在上
 *   5. 置顶/取消置顶：写库 pinned_at，按钮状态即时翻转
 *   6. 随机回忆：弹窗展示 + 再来一张
 *   7. 导出图集：真实 jszip 打包（README + photos/），空图集只提示
 * 用法：NODE_PATH=<workspace>/node_modules node photos-memory.test.mjs
 */
import { createRequire } from 'node:module'
import { photoSrc } from './photo-src.mjs'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')
import fs from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name)
  }
}

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
global.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
global.Node = dom.window.Node
global.Event = dom.window.Event
global.KeyboardEvent = dom.window.KeyboardEvent
global.CustomEvent = dom.window.CustomEvent
global.getComputedStyle = dom.window.getComputedStyle
global.requestAnimationFrame = (cb) => setTimeout(cb, 0)
global.cancelAnimationFrame = (id) => clearTimeout(id)

const alerts = []
globalThis.alert = (msg) => alerts.push(String(msg))

// jsdom 没有 createObjectURL；导出下载用。记录最后一次打包的 blob 供 zip 内容断言
let zippedBlob = null
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = (b) => {
    zippedBlob = b
    return 'blob:stub'
  }
  globalThis.URL.revokeObjectURL = () => {}
} else {
  const orig = globalThis.URL.createObjectURL
  globalThis.URL.createObjectURL = (b) => {
    zippedBlob = b
    return orig(b)
  }
}

// fetch stub：导出时下载“原图”
globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e])]) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tick = (ms = 10) => sleep(ms)

// ---------- 内存数据库 / supabase stub ----------
const db = { photos: [], albums: [], delete_requests: [] }
const bucket = {}

const match = (row, filters) =>
  filters.every((f) =>
    f.op === 'eq'
      ? row[f.col] === f.val
      : f.op === 'is'
        ? (row[f.col] ?? null) === f.val // DB 默认 null；stub 行缺字段(undefined)视同 null
        : Array.isArray(f.val) && f.val.includes(row[f.col]),
  )

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
      filters.push({ col, op: 'is', val })
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
      await tick(5)
      let out = db[table].filter((r) => match(r, filters))
      if (orderCfg) {
        const dir = orderCfg.ascending ? 1 : -1
        out = [...out].sort((a, b) => (a[orderCfg.col] > b[orderCfg.col] ? dir : -dir))
      }
      return { data: structuredClone(out), error: null }
    }
    if (op === 'insert') {
      const arr = Array.isArray(rowsArg) ? rowsArg : [rowsArg]
      const inserted = arr.map((r) => ({
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)),
      }))
      db[table].push(...inserted)
      if (wantSingle) return { data: inserted[0] || null, error: null }
      return { data: null, error: null }
    }
    if (op === 'update') {
      db[table].forEach((r) => {
        if (match(r, filters)) Object.assign(r, patch)
      })
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

const supabase = {
  from: (t) => makeQuery(t),
  storage: {
    from: () => ({
      upload: async (p) => {
        bucket[p] = { size: 10 }
        return { data: { path: p }, error: null }
      },
      remove: async (paths) => ({ data: paths.map((p) => ({ name: p })), error: null }),
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

const supabaseStubSource = 'export const supabase = globalThis.__SUPABASE_STUB__'
const storeStubSource = `
export function StoreProvider({ children }) { return children }
export function useStore() {
  return { coupleId: 'c1', user: globalThis.__ME, members: globalThis.__MEMBERS }
}
`

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

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'photos-memory.bundle.cjs')
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

const ReactDomClient = require('react-dom/client')
const ReactCore = require('react')

const MEMBERS = [
  { user_id: 'u1', nickname: '我' },
  { user_id: 'u2', nickname: '宝贝' },
]
globalThis.__MEMBERS = MEMBERS

const bodyText = () => document.body.textContent || ''
const lastModal = () => {
  const ms = [...document.querySelectorAll('div.fixed.inset-0')]
  return ms[ms.length - 1]
}
const tiles = () => [...document.querySelectorAll('[draggable="true"]')]

function clickByText(text, scope = document, { idx = 'last' } = {}) {
  const els = [...scope.querySelectorAll('button, [role="button"], div, span, p')]
    .filter((el) => (el.textContent || '').trim().includes(text))
    .filter((el) => ![...el.querySelectorAll('*')].some((c) => (c.textContent || '').trim().includes(text)))
  if (els.length === 0) throw new Error(`clickByText 找不到「${text}」; body=${bodyText().slice(0, 300).replace(/\s+/g, ' ')}`)
  const el = idx === 'last' ? els[els.length - 1] : els[0]
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  return el
}

async function waitFor(fn, label, timeout = 4000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      if (fn()) return
    } catch {}
    await tick(10)
  }
  throw new Error('waitFor 超时: ' + label)
}

let root = null
async function mount() {
  if (root) {
    root.unmount()
    await tick(30)
  }
  globalThis.__ME = { id: 'u1' }
  const container = document.getElementById('root')
  container.innerHTML = ''
  root = ReactDomClient.createRoot(container)
  root.render(ReactCore.createElement(Photos))
  await waitFor(() => tiles().length > 0 || bodyText().includes('没有'), 'photos rendered')
  await tick(40)
}

// ============================================================
console.log('\n场景 0：迁移文件齐备')

{
  const a = fs.readFileSync('D:/love/supabase/migrations/028_photos_memory_desc.sql', 'utf8')
  const b = fs.readFileSync('D:/love/supabase/migrations/029_photos_memory_pin.sql', 'utf8')
  ok(a.includes("add column if not exists description text"), 'a：albums 加 description')
  ok(b.includes("add column if not exists pinned_at timestamptz"), 'b：photos 加 pinned_at')
  ok(a.includes("notify pgrst") && b.includes("notify pgrst"), '两个迁移都 notify pgrst 重载 schema')
  // Photos.jsx 已拆成 src/views/photos/ 多模块，扫描要覆盖整个目录
  const src = photoSrc()
  ok(/await import\('jszip'\)/.test(src), '导出按需动态加载 jszip（不进主包）')
  // 三处文件清理（懒清理过期 / 彻底删除 / 一键清空）都必须带缩略图，防孤儿文件回归
  const cleanups = src.match(/\[\.\.\.new Set\(\[[^\]]*storage_path[^\]]*\]\.filter\(Boolean\)\)\]/g) || []
  ok(cleanups.length === 3, `共 3 处文件清理点（实测 ${cleanups.length} 处）`)
  ok(cleanups.length > 0 && cleanups.every((s) => s.includes('thumb_path')), '三处清理都包含 thumb_path')
  // 浏览方式按 userId + coupleId 双维度隔离（与未读基线同一约定）
  ok(src.includes('love_photos_browse_v1_'), '浏览方式按 userId 隔离（love_photos_browse_v1_<uid>）')
  ok(src.includes('.couples?.'), '浏览方式按 coupleId 嵌套（couples.<cid>.mode）')
  ok(!/localStorage\.getItem\('love_photos_browse'\)/.test(src), '旧的全局 key 已移除')
}

// ---------- 造数据：a1 有简介+3 张（p4 置顶），a2 空图集，p3 未分组 ----------
db.albums.push(
  { id: 'a1', couple_id: 'c1', name: '2026 夏天', description: '海边的风', created_at: '2026-06-01T00:00:00Z' },
  { id: 'a2', couple_id: 'c1', name: '空空如也', description: null, created_at: '2026-06-02T00:00:00Z' },
)
db.photos.push(
  { id: 'p1', couple_id: 'c1', author_user_id: 'u1', storage_path: 'photos/c1/p1.jpg', caption: '七月', album_id: 'a1', created_at: '2026-07-15T10:00:00Z' },
  { id: 'p2', couple_id: 'c1', author_user_id: 'u2', storage_path: 'photos/c1/p2.jpg', caption: '', album_id: 'a1', created_at: '2026-08-15T10:00:00Z' },
  { id: 'p3', couple_id: 'c1', author_user_id: 'u1', storage_path: 'photos/c1/p3.jpg', caption: '旧照', album_id: null, created_at: '2025-01-15T10:00:00Z' },
  { id: 'p4', couple_id: 'c1', author_user_id: 'u2', storage_path: 'photos/c1/p4.jpg', original_path: 'originals/c1/p4.jpg', caption: '六月的海', album_id: 'a1', pinned_at: '2026-09-01T00:00:00Z', created_at: '2026-06-15T10:00:00Z' },
)

console.log('\n场景 1：未分组视图 + 顶部「回忆」入口')

await mount()
{
  ok(bodyText().includes('1 张照片'), '未分组只有 p3 一张')
  ok(bodyText().includes('🎲 回忆'), '标题栏有随机回忆入口')
  const chipImgs = [...document.querySelectorAll('img')].map((i) => i.getAttribute('src'))
  ok(chipImgs.some((s) => s.includes('p3')), '未分组胶囊封面 = p3')
}

console.log('\n场景 2：图集信息卡 —— 封面自动生成 / 时间范围 / 简介')

await clickByText('2026 夏天')
await tick(60)
{
  ok(bodyText().includes('海边的风'), '简介显示在信息卡')
  ok(bodyText().includes('2026年6月 - 2026年8月 · 3 张'), '时间范围 = 最早 ~ 最近')
  // 封面：p4 置顶优先（信息卡大图 + 胶囊小图都应是 p4）
  const heroImgs = [...document.querySelectorAll('img')].map((i) => i.getAttribute('src'))
  ok(heroImgs.filter((s) => s.includes('p4')).length >= 2, '封面自动生成：置顶照片 p4 优先（信息卡 + 胶囊）')
  ok(bodyText().includes('📌'), '封面角标显示置顶 📌')
  ok(bodyText().includes('✏️ 编辑') && bodyText().includes('⬇ 导出'), '信息卡有编辑 / 导出入口')
}

console.log('\n场景 3：网格排序 —— 置顶浮最前 + 📌 徽标')

{
  const srcs = tiles().map((t) => t.querySelector('img')?.getAttribute('src') || '')
  ok(srcs.length === 3, '图集内 3 个瓦片')
  ok(srcs[0].includes('p4'), '第 1 张 = 置顶的 p4')
  ok(srcs[1].includes('p2') && srcs[2].includes('p1'), '其余按时间新 → 旧（p2、p1）')
  const pinBadges = [...document.querySelectorAll('span')].filter((s) => s.textContent.trim() === '📌')
  ok(pinBadges.length >= 2, '置顶徽标出现（瓦片 + 封面角标）')
}

console.log('\n场景 4：时间线视图 —— 按年月分组、新的在上')

{
  clickByText('🕑')
  await tick(60)
  // 信息卡里也有「2026年8月」（时间范围文案），所以分组断言收窄到时间线容器
  const groups = [...document.querySelectorAll('.pl-6')]
  ok(groups.length === 3, '时间线渲染 3 个年月分组')
  const gtxt = groups.map((g) => g.textContent || '')
  ok(
    gtxt[0].includes('2026年8月 · 1 张') && gtxt[1].includes('2026年7月 · 1 张') && gtxt[2].includes('2026年6月 · 1 张'),
    '分组排序：新的在上',
  )
  const tlSrcs = tiles().map((t) => t.querySelector('img')?.getAttribute('src') || '')
  ok(tlSrcs[0].includes('p2') && tlSrcs[1].includes('p1') && tlSrcs[2].includes('p4'), '时间线按纯时间排序（忽略置顶）')
  clickByText('▦')
  await tick(40)
}

console.log('\n场景 5：置顶 / 取消置顶 —— 写库 pinned_at、按钮即时翻转')

{
  // 打开 p1 的大图（网格里第 3 个瓦片：p4、p2、p1）
  tiles()[2].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await tick(60)
  const m = lastModal()
  ok(!!m && m.textContent.includes('七月'), '大图弹窗打开（p1 七月）')
  clickByText('置顶', m)
  await tick(80)
  ok(!!db.photos.find((p) => p.id === 'p1').pinned_at, '置顶写入 pinned_at')
  ok(lastModal().textContent.includes('📌 取消'), '按钮翻转为「取消置顶」')
  clickByText('取消', lastModal())
  await tick(80)
  ok(!db.photos.find((p) => p.id === 'p1').pinned_at, '取消置顶清空 pinned_at')
  // 关掉弹窗
  clickByText('✕', lastModal())
  await tick(40)
}

console.log('\n场景 6：随机回忆')

{
  clickByText('🎲 回忆')
  await tick(60)
  let m = lastModal()
  ok(!!m && m.textContent.includes('随机回忆'), '回忆弹窗打开')
  ok(!!m.querySelector('img'), '弹窗里有大图')
  ok(/年\d+月\d+日/.test(m.textContent), '显示完整日期')
  ok(m.textContent.includes('上传'), '显示上传者')
  clickByText('再来一张', m)
  await tick(60)
  m = lastModal()
  ok(m.textContent.includes('随机回忆'), '「再来一张」继续抽（弹窗保持）')
  clickByText('✕', m)
  await tick(40)
}

console.log('\n场景 7：导出图集 —— 真实 jszip 打包')

{
  zippedBlob = null
  clickByText('⬇ 导出')
  await waitFor(() => bodyText().includes('图集已打包完成'), 'export done')
  await tick(50)
  ok(!!zippedBlob, '产出 zip blob 并触发下载')
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(zippedBlob)
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
  ok(names.some((n) => n === 'README.txt'), 'zip 内有 README.txt')
  const readme = await zip.file('README.txt').async('string')
  ok(readme.includes('图集：2026 夏天'), 'README：图集名')
  ok(readme.includes('简介：海边的风'), 'README：简介')
  ok(readme.includes('时间范围：2026年6月 - 2026年8月，共 3 张'), 'README：时间范围 + 张数')
  const photoNames = names.filter((n) => n.startsWith('photos/'))
  ok(photoNames.length === 3, 'zip 内 3 张照片')
  ok(photoNames.includes('photos/01_2026-06-15_六月的海.jpg'), '文件名 = 序号_日期_备注（p4 含 original_path 优先用原图）')
  ok(photoNames.includes('photos/02_2026-07-15_七月.jpg'), '按时间正序编号（p1 第二）')
}

console.log('\n场景 8：空图集导出 —— 只提示，不打包')

{
  zippedBlob = null
  await clickByText('空空如也')
  await tick(60)
  ok(bodyText().includes('还没有照片'), '空图集信息卡提示')
  clickByText('⬇ 导出')
  await tick(60)
  ok(bodyText().includes('这个图集还没有照片，导不出东西'), '空图集导出给出提示')
  ok(!zippedBlob, '没有产生 zip')
}

console.log('\n场景 9：无_alert 报错')

ok(alerts.length === 0, `全程无 alert 报错（${alerts.join(' | ') || '干净'}）`)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exit(1)
