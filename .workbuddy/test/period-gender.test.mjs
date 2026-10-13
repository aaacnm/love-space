/**
 * 生理期男女差异测试：男生关怀视角（care 模式）+ 女生默认模式
 *
 * care 模式判定：myMember.gender === 'male'
 *   - 标题「💗 她的周期」、隐藏 ⚙ 设置
 *   - 「💗 她今天的状态」显示她的打卡摘要与备注
 *   - 「💗 今天这样照顾她」行动清单（结合她的疼痛/心情/流量/症状 + 周期阶段）
 *   - 无「去打卡」、无历史「删除」、日历详情无「记状态」按钮、记录按钮改「帮她记一笔」
 * 女生 / 未设置性别 → 默认模式（原样）
 *
 * 用法：NODE_PATH=<workspace>/node_modules node period-gender.test.mjs
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------- jsdom ----------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true })
global.HTMLElement = dom.window.HTMLElement
global.Node = dom.window.Node
global.Event = dom.window.Event
global.getComputedStyle = dom.window.getComputedStyle
global.requestAnimationFrame = (cb) => setTimeout(cb, 0)
global.cancelAnimationFrame = (id) => clearTimeout(id)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tick = (ms = 10) => sleep(ms)

// ---------- supabase stub（与 period.test.mjs 同款最小桩） ----------
const db = { period_logs: [], period_settings: [], period_daily_logs: [] }
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
    insert(rows) {
      op = 'insert'
      rowsArg = rows
      return q
    },
    upsert(rows, opts = {}) {
      op = 'upsert'
      rowsArg = rows
      q._onConflict = opts.onConflict || 'id'
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
    single() {
      return q
    },
  }
  q.then = (onFul, onRej) => run().then(onFul, onRej)
  async function run() {
    if (op === 'select') {
      await sleep(15)
      let out = db[table].filter((r) => match(r, filters))
      if (orderCfg) {
        const dir = orderCfg.ascending ? 1 : -1
        out = [...out].sort((a, b) => (a[orderCfg.col] > b[orderCfg.col] ? dir : -dir))
      }
      return { data: structuredClone(out), error: null }
    }
    if (op === 'insert' || op === 'upsert') {
      const arr = Array.isArray(rowsArg) ? rowsArg : [rowsArg]
      const inserted = arr.map((r) => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }))
      if (op === 'upsert') {
        const cols = String(q._onConflict).split(',').map((c) => c.trim())
        for (const row of inserted) {
          const idx = db[table].findIndex((r) => cols.every((c) => r[c] === row[c]))
          if (idx >= 0) Object.assign(db[table][idx], row)
          else db[table].push(row)
        }
      } else {
        db[table].push(...inserted)
      }
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

globalThis.__SUPABASE_STUB__ = {
  from: (t) => makeQuery(t),
  channel: () => {
    const ch = { on() { return ch }, subscribe() { return ch } }
    return ch
  },
  removeChannel() {},
}

const supabaseStubSource = 'export const supabase = globalThis.__SUPABASE_STUB__'
const storeStubSource = `
export function StoreProvider({ children }) { return children }
export function useStore() {
  return { coupleId: 'c1', user: globalThis.__ME, members: globalThis.__MEMBERS, myMember: globalThis.__MY_MEMBER || null }
}
`

// ---------- 打包 ----------
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

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'period-gender.bundle.cjs')
await esbuild.build({
  entryPoints: ['D:/love/src/views/Period.jsx'],
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

const { computeCycle, partnerCareActions, default: Period } = require(out)
const ReactDomClient = require('react-dom/client')
const ReactCore = require('react')

// ---------- 断言工具 ----------
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
const bodyText = () => document.body.textContent || ''
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const shift = (n) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return dayKey(d)
}
const TODAY = shift(0)
const hasBtn = (t) => [...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes(t))
const modals = () => [...document.querySelectorAll('div.fixed.inset-0')]
const lastModal = () => modals()[modals().length - 1]

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
async function mount(waitText) {
  if (root) {
    root.unmount()
    await tick(30)
  }
  const container = document.getElementById('root')
  container.innerHTML = ''
  root = ReactDomClient.createRoot(container)
  root.render(ReactCore.createElement(Period))
  await waitFor(() => bodyText().includes(waitText), '渲染 ' + waitText)
  await tick(40)
}

function seed() {
  db.period_logs = [{ id: 'pl1', couple_id: 'c1', start_date: shift(-1), created_at: new Date().toISOString() }]
  db.period_settings = [{ couple_id: 'c1', cycle_len: 28, period_len: 5, updated_at: new Date().toISOString() }]
  db.period_daily_logs = [
    {
      id: 'd1',
      couple_id: 'c1',
      user_id: 'u2',
      log_date: TODAY,
      flow: 'heavy',
      pain: 2,
      mood: 'irritable',
      symptoms: ['怕冷', '疲惫'],
      note: '累死了',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ]
}

// ---------- 单元：partnerCareActions ----------
console.log('\n单测：partnerCareActions')
{
  ok(partnerCareActions(null, null).length === 0, '无周期无打卡 → 无建议')
  ok(partnerCareActions({ last: null }, { pain: 3 }).length > 0, '有打卡无周期 → 只给打卡相关建议')

  const actsLate = partnerCareActions({ last: 'x', phase: 'late', delay: 3, cycleLen: 28, periodLen: 5, starts: [] }, null)
  ok(actsLate.some((a) => a.includes('别追问')), '推迟 → 提醒别追问')

  const actsFertile = partnerCareActions(
    { last: 'x', phase: 'fertile', delay: -10, ovuDay: shift(4), cycleLen: 28, periodLen: 5, starts: [] },
    null,
  )
  ok(actsFertile.some((a) => a.includes('易孕窗口')), '易孕期 → 易孕提醒')

  const actsSoon = partnerCareActions({ last: 'x', phase: 'luteal', delay: -2, nextStart: shift(2), cycleLen: 28, periodLen: 5, starts: [] }, null)
  ok(actsSoon.some((a) => a.includes('备好卫生巾')), '将至（≤2 天）→ 提前准备')

  const actsFar = partnerCareActions({ last: 'x', phase: 'luteal', delay: -15, nextStart: shift(15), cycleLen: 28, periodLen: 5, starts: [] }, null)
  ok(actsFar.length === 0, '黄体期远离经期 → 无阶段建议')
}

// ---------- 组件：男生关怀视角 ----------
console.log('\n组件：男生关怀模式')
globalThis.__MEMBERS = [
  { user_id: 'u1', nickname: '我', gender: 'male' },
  { user_id: 'u2', nickname: '宝贝', gender: 'female' },
]
globalThis.__ME = { id: 'u1' }
globalThis.__MY_MEMBER = { user_id: 'u1', nickname: '我', gender: 'male' }
seed()
await mount('她的周期')

ok(bodyText().includes('💗 她的周期'), '标题为「💗 她的周期」')
ok(!hasBtn('设置'), '男生端隐藏 ⚙ 设置')
ok(bodyText().includes('经期第 2 天'), '状态卡显示她的周期阶段')
ok(bodyText().includes('她今天的状态'), '有「她今天的状态」卡')
ok(bodyText().includes('量多') && bodyText().includes('累死了'), '她的打卡摘要与备注可见')
ok(bodyText().includes('热水袋'), '她痛经明显 → 热水袋建议')
ok(bodyText().includes('不讲道理'), '她烦躁 → 别讲道理建议')
ok(bodyText().includes('暖宝宝'), '她怕冷 → 暖宝宝建议')
ok(bodyText().includes('生冷辛辣'), '经期阶段 → 饮食提醒')
ok(!hasBtn('去打卡') && !hasBtn('编辑'), '男生端无「去打卡/编辑」入口')
ok(!bodyText().includes('删除'), '男生端历史无删除按钮')
ok(bodyText().includes('帮她记一笔'), '记录入口变为「帮她记一笔」')

// 日历详情：男生只能看，无记状态按钮
const dayBtns = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === String(new Date().getDate()))
dayBtns[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
await tick(60)
ok(!!lastModal(), '日历详情弹窗打开')
ok(!bodyText().includes('记一下这天的状态'), '男生端详情无「记状态」按钮')
ok(bodyText().includes('宝贝'), '详情里看得到她的打卡署名')

// ---------- 组件：女生默认模式 ----------
console.log('\n组件：女生默认模式（完整记录功能）')
globalThis.__MY_MEMBER = { user_id: 'u1', nickname: '我', gender: 'female' }
seed()
await mount('🌸 生理期')

ok(bodyText().includes('🌸 生理期'), '标题为「🌸 生理期」')
ok(hasBtn('设置'), '女生端有 ⚙ 设置')
ok(hasBtn('去打卡'), '女生端有「去打卡」')
ok(bodyText().includes('记录这次生理期'), '记录入口为「记录这次生理期」')
ok(bodyText().includes('删除'), '女生端历史有删除按钮')
ok(bodyText().includes('宝贝：'), '打卡卡里也看得到对方的摘要')

// ---------- 组件：未设置性别 → 默认模式 ----------
console.log('\n组件：未设置性别 → 默认模式')
globalThis.__MY_MEMBER = { user_id: 'u1', nickname: '我' }
seed()
await mount('🌸 生理期')
ok(bodyText().includes('记录这次生理期') && hasBtn('去打卡'), '未设置性别按默认模式渲染')

// ---------- 结果 ----------
console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`)
if (failures.length) {
  console.log('失败项：')
  failures.forEach((f) => console.log('  -', f))
  process.exit(1)
}
