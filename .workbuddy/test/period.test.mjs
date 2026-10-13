/**
 * 生理期（Period）测试：纯函数单测 + jsdom 组件冒烟
 *
 * 用法：NODE_PATH=<workspace>/node_modules node period.test.mjs
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

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

// ---------- supabase stub ----------
const db = { period_logs: [], period_settings: [], period_daily_logs: [] }
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
      wantSingle = true
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
      const inserted = arr.map((r) => {
        const clean = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined))
        return { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...clean }
      })
      if (op === 'upsert') {
        // 支持复合唯一键（如 'couple_id,user_id,log_date'）
        const cols = String(q._onConflict).split(',').map((c) => c.trim())
        for (const row of inserted) {
          const idx = db[table].findIndex((r) => cols.every((c) => r[c] === row[c]))
          if (idx >= 0) Object.assign(db[table][idx], row)
          else db[table].push(row)
        }
      } else {
        db[table].push(...inserted)
      }
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
  return { coupleId: 'c1', user: globalThis.__ME, members: globalThis.__MEMBERS }
}
`

// ---------- 打包（bare import 一律 external，与外层共用同一份 React） ----------
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

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'period.bundle.cjs')
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

const { computeCycle, buildMarks, default: Period } = require(out)
const ReactDomClient = require('react-dom/client')
const ReactCore = require('react')

// ---------- 工具 ----------
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
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const shift = (n) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return dayKey(d)
}
const TODAY = shift(0)

// ================= 单元测试：computeCycle =================
console.log('\n单测：computeCycle / buildMarks')
{
  const C0 = computeCycle([], null, TODAY)
  ok(C0.last === null && C0.starts.length === 0, '无记录时 last 为空')

  const C1 = computeCycle([{ start_date: TODAY }], null, TODAY)
  ok(C1.phase === 'period' && C1.title.includes('第 1 天'), '今天开始 → 经期第 1 天')

  const C2 = computeCycle([{ start_date: shift(-1) }], { cycle_len: 28, period_len: 5 }, TODAY)
  ok(C2.title.includes('第 2 天'), '昨天开始 → 经期第 2 天')
  ok(C2.cycleLen === 28, '无有效样本时用设置周期 28')
  ok(C2.delay === -27, '距下次还有 27 天（delay=-27）')

  // 两条间隔 28：今天 = 上次开始 + 28 → 预计今天来
  const C3 = computeCycle([{ start_date: shift(-28) }, { start_date: shift(-56) }], null, TODAY)
  ok(C3.cycleLen === 28, '两条间隔 28 → 周期取 28')
  ok(C3.delay === 0 && C3.phase === 'luteal', '今天=预测开始日 → 黄体期（副标题显示预计今天来）')

  // 间隔 30、28 → 平均 29
  const C4 = computeCycle(
    [{ start_date: shift(-58) }, { start_date: shift(-28) }, { start_date: shift(-86) }],
    null,
    TODAY,
  )
  ok(C4.cycleLen === 29, '间隔 28/30 → 平均 29')

  // 异常间隔（<15）不算样本
  const C5 = computeCycle([{ start_date: TODAY }, { start_date: shift(-10) }], { cycle_len: 30 }, TODAY)
  ok(C5.cycleLen === 30, '间隔 10 天不合理 → 忽略样本用设置 30')

  // 推迟：上次开始 35 天前，周期 28 → 推迟 7 天
  const C6 = computeCycle([{ start_date: shift(-35) }], { cycle_len: 28, period_len: 5 }, TODAY)
  ok(C6.phase === 'late' && C6.delay === 7, '超期 7 天 → late 状态')

  // 排卵日 / 易孕：last=今天-28, cycle 28 → next=今天 → 排卵日=今天-14 → fertile 窗口 今天-19..今天-13
  const C7 = computeCycle([{ start_date: shift(-28) }], { cycle_len: 28, period_len: 5 }, shift(-14))
  ok(C7.phase === 'ovulation', '周期正中 → 排卵日')

  const M = buildMarks(C7)
  ok(M.ovulation.has(shift(-14)), '日历标注排卵日')
  ok(M.predicted.has(shift(28)) && M.predicted.has(shift(29)), '预测经期从下次周期开始（k≥1）')
  ok(!M.predicted.has(shift(-28)), '最近一次实际经期不算预测（k=0 跳过）')
  ok(M.actual.has(shift(-28)) && M.actual.has(shift(-25)), '实际经期从开始日覆盖 periodLen 天')
  ok(M.fertile.has(shift(-19)) && M.fertile.has(shift(-13)), '易孕窗口 = 排卵日前5后1')
}

// ================= 单元测试：六期分期 =================
console.log('\n单测：六期分期（月经/卵泡/易孕/排卵/黄体/推迟）')
{
  // 卵泡期：开始 8 天前、周期 28、经期 5 → dayNo=9，ovu=day14，易孕窗口 day9-15 未到
  const F = computeCycle([{ start_date: shift(-8) }], { cycle_len: 28, period_len: 5 }, TODAY)
  ok(F.phase === 'follicular' && F.title.includes('卵泡期'), '经期后易孕前 → 卵泡期')

  // 黄体期：开始 20 天前 → dayNo=21，ovu=day14 已过，易孕窗口 day9-15 已过
  const L = computeCycle([{ start_date: shift(-20) }], { cycle_len: 28, period_len: 5 }, TODAY)
  ok(L.phase === 'luteal' && L.title.includes('黄体期'), '排卵后未到下次月经 → 黄体期')

  // 排卵日次日仍在易孕窗口（卵子存活约 24h）
  const F1 = computeCycle([{ start_date: shift(-28) }], { cycle_len: 28, period_len: 5 }, shift(-13))
  ok(F1.phase === 'fertile', '排卵日次日 → 仍算易孕期')

  // 推迟标题带天数
  const L7 = computeCycle([{ start_date: shift(-35) }], { cycle_len: 28, period_len: 5 }, TODAY)
  ok(L7.title.includes('7'), '推迟标题显示天数（已推迟 7 天）')

  // 短周期：周期 20、经期 7 → 排卵日=day6，易孕窗口 day1-7 与经期重叠 → 经期优先
  const S = computeCycle([{ start_date: shift(-2) }], { cycle_len: 20, period_len: 7 }, TODAY)
  ok(S.phase === 'period', '短周期经期与易孕重叠 → 经期优先显示')

  // 未来经期：开始日记录在明天 → 今天属于上一周期黄体期末尾，不是"已推迟"
  const PRE = computeCycle([{ start_date: shift(1) }], { cycle_len: 28, period_len: 6 }, TODAY)
  ok(PRE.phase === 'luteal', '记录的开始日在未来 → 今天显示黄体期而非已推迟')

  // 未来经期的日历满色：今天（上周期推导段）有黄体期颜色
  const PRE_M = buildMarks(PRE)
  ok(PRE_M.luteal.has(TODAY) || PRE_M.follicular.has(TODAY) || PRE_M.fertile.has(TODAY) || PRE_M.ovulation.has(TODAY), '今天也在日历分期色里（上周期推导覆盖）')

  // 六期 marks：last=shift(-28)，周期 28、经期 5（与上面的 C7 同款场景）
  const M2 = buildMarks(computeCycle([{ start_date: shift(-28) }], { cycle_len: 28, period_len: 5 }, shift(-14)))
  ok(M2.follicular.has(shift(-22)) && M2.follicular.has(shift(-20)), '卵泡期标注在经期结束到易孕窗口前')
  ok(M2.luteal.has(shift(-10)) && M2.luteal.has(shift(-1)), '黄体期标注在易孕窗口后到下次月经前')
  ok(!M2.luteal.has(shift(-13)), '排卵日次日属于易孕窗口，不进黄体期')
  ok(!M2.follicular.has(shift(-26)) && !M2.luteal.has(shift(-26)), '经期日子不重复标卵泡/黄体期')
  ok(M2.follicular.has(shift(5)), '下一周期铺满卵泡期（整月满色，Flo/美柚样式）')
  ok(M2.luteal.has(shift(16)) && M2.luteal.has(shift(27)), '黄体期铺到下一预测经期前')
  ok(!M2.follicular.has(shift(-40)) && M2.follicular.has(shift(-50)), '往前推导的周期也铺色（过去无记录经期不标）')
}

// ================= 组件冒烟 =================
const MEMBERS = [
  { user_id: 'u1', nickname: '我' },
  { user_id: 'u2', nickname: '宝贝' },
]
globalThis.__MEMBERS = MEMBERS
globalThis.__ME = { id: 'u1' }

let root = null
async function mount() {
  if (root) {
    root.unmount()
    await tick(30)
  }
  const container = document.getElementById('root')
  container.innerHTML = ''
  root = ReactDomClient.createRoot(container)
  root.render(ReactCore.createElement(Period))
  await waitFor(() => document.body.textContent.includes('生理期'), 'Period rendered')
  await tick(40)
}

const bodyText = () => document.body.textContent || ''
const modals = () => [...document.querySelectorAll('div.fixed.inset-0')]
const lastModal = () => modals()[modals().length - 1]

function clickByText(text, scope = document) {
  const els = [...scope.querySelectorAll('button, [role="button"], div, span')]
    .filter((el) => (el.textContent || '').trim().includes(text))
    .filter((el) => ![...el.querySelectorAll('*')].some((c) => (c.textContent || '').trim().includes(text)))
  if (els.length === 0) throw new Error(`clickByText 找不到「${text}」`)
  els[els.length - 1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
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

console.log('\n组件：空状态 + 记录一次')
db.period_logs = []
db.period_settings = []
await mount()
ok(bodyText().includes('还没有记录'), '空数据显示「还没有记录」')
ok(bodyText().includes('记录这次生理期'), '有记录入口')

clickByText('记录这次生理期')
await waitFor(() => lastModal() && lastModal().textContent.includes('记录生理期'), '记录弹窗打开')
clickByText('保存', lastModal())
await tick(120)
ok(db.period_logs.length === 1 && db.period_logs[0].start_date === TODAY, '保存后 period_logs 新增今天一条')
await waitFor(() => bodyText().includes('经期第 1 天'), '状态卡更新为经期第 1 天')
ok(true, '状态卡实时变为「经期第 1 天」')

console.log('\n组件：重复记录防重 + 历史列表')
clickByText('记录这次生理期')
await waitFor(() => lastModal() && lastModal().textContent.includes('记录生理期'), '弹窗再开')
clickByText('保存', lastModal())
await tick(120)
ok(db.period_logs.length === 1, '同一天重复记录被拦截')
ok(bodyText().includes('已经记过了'), '提示「这一天已经记过了」')

// 预置一条 28 天前的记录 → 历史两条 + 状态卡
db.period_logs = [
  { id: 'p1', couple_id: 'c1', start_date: shift(-28), created_at: new Date().toISOString() },
  { id: 'p2', couple_id: 'c1', start_date: TODAY, created_at: new Date().toISOString() },
]
await mount()
await waitFor(() => bodyText().includes('历史记录'), '重新渲染')
ok(bodyText().includes('2 次'), '历史记录计数 2 次')
ok(bodyText().includes('与上次间隔 28 天'), '历史显示与上次的间隔')
ok(bodyText().includes('经期第 1 天'), '今天开始的记录 → 经期第 1 天')
ok(bodyText().includes('距下次生理期还有 28 天'), '副标题显示距下次 28 天')

console.log('\n组件：设置弹窗')
clickByText('⚙ 设置')
await waitFor(() => lastModal() && lastModal().textContent.includes('周期设置'), '设置弹窗')
clickByText('保存', lastModal())
await tick(120)
ok(db.period_settings.length === 1 && db.period_settings[0].cycle_len === 28, '设置保存成功（upsert 一行）')

console.log('\n组件：删除历史记录')
clickByText('删除', document)
await waitFor(() => lastModal() && lastModal().textContent.includes('确定删除这条生理期记录'), '删除确认弹窗')
clickByText('删除', lastModal())
await tick(120)
ok(db.period_logs.length === 1, '确认后记录被删除')

console.log('\n组件 G：每日打卡（保存 / 摘要 / 编辑更新 / 删除）')
db.period_daily_logs = []
db.period_logs = [{ id: 'p2', couple_id: 'c1', start_date: TODAY, created_at: new Date().toISOString() }]
await mount()
await waitFor(() => bodyText().includes('今天的状态'), '打卡条渲染')
ok(bodyText().includes('去打卡'), '未打卡显示「去打卡」')
clickByText('去打卡')
await waitFor(() => lastModal() && lastModal().textContent.includes('今天的状态'), '打卡弹窗打开')
// 选流量「适中」、痛经「轻微」、心情「平静」、症状「腹痛」「腰酸」
clickByText('适中', lastModal())
clickByText('轻微', lastModal())
clickByText('平静', lastModal())
clickByText('腹痛', lastModal())
clickByText('腰酸', lastModal())
// 备注输入
const noteInput = lastModal().querySelector('input')
const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
valueSetter.call(noteInput, '今天有点累')
noteInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
clickByText('保存', lastModal())
await tick(150)
ok(db.period_daily_logs.length === 1, '打卡保存为 1 条')
const saved = db.period_daily_logs[0]
ok(saved.flow === 'medium' && saved.pain === 1 && saved.mood === 'calm', '流量/痛经/心情保存正确')
ok(Array.isArray(saved.symptoms) && saved.symptoms.includes('腹痛') && saved.symptoms.includes('腰酸'), '症状多选保存正确')
ok(saved.note === '今天有点累' && saved.user_id === 'u1', '备注与 user_id 正确')
await waitFor(() => bodyText().includes('我：🩸🩸适中'), '打卡条显示我的摘要')
// 编辑：改成少量，upsert 应更新而不是新增
clickByText('编辑', document)
await waitFor(() => lastModal() && lastModal().textContent.includes('今天的状态'), '编辑弹窗打开')
clickByText('少量', lastModal())
await tick(40) // 让 React 渲染新的 form 闭包，再点更新
clickByText('更新', lastModal())
await tick(200)
ok(db.period_daily_logs.length === 1 && db.period_daily_logs[0].flow === 'light', '同日再打卡按唯一键更新，不新增')
// 删除
clickByText('编辑', document)
await waitFor(() => lastModal() && lastModal().textContent.includes('删除这条打卡'), '弹窗出现删除入口')
clickByText('删除这条打卡', lastModal())
await tick(150)
ok(db.period_daily_logs.length === 0, '删除打卡成功')

console.log('\n组件 H：日历点选详情（阶段标签 + 双方打卡 + 补记入口）')
db.period_daily_logs = [
  { id: 'd1', couple_id: 'c1', user_id: 'u1', log_date: TODAY, flow: 'light', pain: 0, mood: 'happy', symptoms: ['腹痛', '腰酸'], created_at: new Date().toISOString() },
  { id: 'd2', couple_id: 'c1', user_id: 'u2', log_date: TODAY, flow: 'none', pain: 2, mood: 'irritable', symptoms: ['腹痛'], created_at: new Date().toISOString() },
]
await mount()
await waitFor(() => bodyText().includes('今天的状态'), '重渲染')
const todayNum = String(new Date().getDate())
const todayCell = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === todayNum && b.className.includes('ring-2'))
ok(!!todayCell, '今天格子有描边（可点击）')
todayCell.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
await waitFor(() => lastModal() && lastModal().textContent.includes('经期'), '详情弹窗显示阶段')
ok(lastModal().textContent.includes('🌸 月经期'), '今天 = 月经期阶段标签')
ok(lastModal().textContent.includes('我') && lastModal().textContent.includes('宝贝'), '显示双方打卡与昵称')
ok(lastModal().textContent.includes('编辑我这一天的状态'), '已有我的打卡 → 编辑入口')
// TA 的今日打卡在打卡条上也可见
ok(bodyText().includes('宝贝：'), '打卡条显示 TA 的今日状态')

console.log('\n组件 I：关怀卡 + 周期分析')
await mount()
await waitFor(() => bodyText().includes('经期关怀'), '经期阶段 → 关怀卡出现')
ok(bodyText().includes('热水袋'), '关怀文案包含照顾建议')
// 加一条 28 天前的记录 → 样本 1 个 → 平均周期显示、波动无（样本<2）
db.period_logs = [
  { id: 'p1', couple_id: 'c1', start_date: shift(-28), created_at: new Date().toISOString() },
  { id: 'p2', couple_id: 'c1', start_date: TODAY, created_at: new Date().toISOString() },
]
await mount()
await waitFor(() => bodyText().includes('周期分析'), '统计卡出现')
ok(bodyText().includes('平均周期（天）'), '统计卡含平均周期')
ok(bodyText().includes('常见症状') && bodyText().includes('腹痛 ×2'), '常见症状聚合（腹痛 ×2）')

console.log(`\n========== 结果：${pass} 通过 / ${failures.length} 失败 ==========`)
if (failures.length) {
  failures.forEach((f) => console.log('FAILED:', f))
  process.exit(1)
}
