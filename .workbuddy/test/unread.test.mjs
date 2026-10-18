/**
 * 统一「未读和提醒」机制的 jsdom 测试
 *   1. 基线计数：留言(含评论)/日记评论/想聊聊/戳一戳/心情 五个桶
 *   2. 进入留言/日记页自动清除（基线吸收），离开后新内容才再计
 *   3. 实时事件防抖重查：新留言/心情更新增量生效
 *   4. markSeen / unread:seen 事件清除
 *   5. 首次使用基线=现在：老内容不淹没未读，心情快照静默初始化
 *   6. TabBar 红点渲染（想聊聊时脉冲）、首页卡片条目与点击行为
 *   7. 换空间（同用户不同 coupleId）：基线按空间隔离、互不串扰、旧版扁平结构自动迁移
 *
 * 用法：NODE_PATH=<workspace>/node_modules node unread.test.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------- jsdom 环境 ----------
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
global.CustomEvent = dom.window.CustomEvent
global.getComputedStyle = dom.window.getComputedStyle
global.localStorage = dom.window.localStorage
global.requestAnimationFrame = (cb) => setTimeout(cb, 0)
global.cancelAnimationFrame = (id) => clearTimeout(id)
// jsdom 没有 requestIdleCallback：补一个「下一轮宏任务」的实现，
// 让「首屏画完再刷未读」的延迟（lib/idle.js）在测试里很快兑现，而不是干等 400ms 的降级定时器
const idleShim = (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0)
if (!dom.window.requestIdleCallback) {
  dom.window.requestIdleCallback = idleShim
  dom.window.cancelIdleCallback = (id) => clearTimeout(id)
}
global.requestIdleCallback = dom.window.requestIdleCallback
global.cancelIdleCallback = dom.window.cancelIdleCallback

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tick = (ms = 10) => sleep(ms)

let pass = 0
const fails = []
const ok = (cond, msg) => {
  if (cond) pass++
  else fails.push(msg)
}

// ---------- 内存数据库 / supabase stub ----------
const T0 = '2026-01-01T00:00:00.000Z'
const OLD = '2026-01-05T08:00:00.000Z'
const db = { messages: [], message_comments: [], diary_comments: [], pokes: [], moods: [] }

function seed() {
  db.messages = [
    { id: 'm1', couple_id: 'c1', author_user_id: 'u2', content: '早', created_at: OLD },
    { id: 'm2', couple_id: 'c1', author_user_id: 'u2', content: '晚安', created_at: OLD },
    { id: 'm3', couple_id: 'c1', author_user_id: 'u1', content: '我的', created_at: OLD },
  ]
  db.message_comments = [{ id: 'mc1', couple_id: 'c1', message_id: 'm3', author_user_id: 'u2', content: '回复', created_at: OLD }]
  db.diary_comments = [
    { id: 'dc1', couple_id: 'c1', diary_id: 'd1', author_user_id: 'u2', content: '写得好', created_at: OLD },
    { id: 'dc2', couple_id: 'c1', diary_id: 'd1', author_user_id: 'u2', content: '抱抱', created_at: OLD },
  ]
  db.pokes = [
    { id: 'p1', couple_id: 'c1', from_user_id: 'u2', kind: 'chat', created_at: OLD },
    { id: 'p2', couple_id: 'c1', from_user_id: 'u2', kind: 'poke', created_at: OLD },
    { id: 'p3', couple_id: 'c1', from_user_id: 'u2', kind: 'poke', created_at: OLD },
    { id: 'p4', couple_id: 'c1', from_user_id: 'u1', kind: 'poke', created_at: OLD },
  ]
  db.moods = [{ id: 'mo1', couple_id: 'c1', user_id: 'u2', mood: '开心', date: '2026-01-05', created_at: OLD }]
}
seed()

function makeQuery(table) {
  let op = 'select'
  let head = false
  const filters = []
  let orderCfg = null
  let limitN = null
  const q = {
    select(_cols, opts) {
      head = !!(opts && opts.head && opts.count === 'exact')
      return q
    },
    eq(col, val) {
      filters.push(['eq', col, val])
      return q
    },
    neq(col, val) {
      filters.push(['neq', col, val])
      return q
    },
    gt(col, val) {
      filters.push(['gt', col, val])
      return q
    },
    order(col, cfg) {
      orderCfg = { col, ...cfg }
      return q
    },
    limit(n) {
      limitN = n
      return q
    },
    single() {
      return q
    },
  }
  const applyFilters = (rows) =>
    rows.filter((r) =>
      filters.every(([op, col, val]) =>
        op === 'eq' ? r[col] === val : op === 'neq' ? r[col] !== val : op === 'gt' ? String(r[col]) > String(val) : true,
      ),
    )
  q.then = (onFul, onRej) => run().then(onFul, onRej)
  async function run() {
    let out = applyFilters(db[table] || [])
    if (orderCfg) {
      const dir = orderCfg.ascending ? 1 : -1
      out = [...out].sort((a, b) => (a[orderCfg.col] > b[orderCfg.col] ? dir : -dir))
    }
    if (limitN != null) out = out.slice(0, limitN)
    if (head) return { count: out.length, data: null, error: null }
    return { data: structuredClone(out), error: null }
  }
  return q
}

// 实时频道：捕获所有回调，测试用 __UNREAD_TRIGGER__ 手动派发
const channelHandlers = []
const supabase = {
  from: (t) => makeQuery(t),
  channel: () => {
    const ch = {
      on(_type, opts, cb) {
        channelHandlers.push({ table: opts.table, cb })
        return ch
      },
      subscribe() {
        return ch
      },
    }
    return ch
  },
  removeChannel() {
    channelHandlers.length = 0
  },
}
globalThis.__UNREAD_TRIGGER__ = (table, row) => {
  for (const h of [...channelHandlers]) if (h.table === table) h.cb({ new: structuredClone(row) })
}

const supabaseStubSource = 'export const supabase = globalThis.__SUPABASE_STUB__'
const storeStubSource = `
export function StoreProvider({ children }) { return children }
export function useStore() { return globalThis.__STORE_VALUE__ }
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

// ---------- 打包 Harness ----------
const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'unread-harness.bundle.cjs')
await esbuild.build({
  entryPoints: [path.join(here, 'unread-harness.jsx')],
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
const { Harness } = require(out)

const ReactDomClient = require('react-dom/client')
const ReactCore = require('react')

const probeState = () => JSON.parse(document.getElementById('probe').textContent)
const bodyText = () => document.body.textContent || ''
const clickBtn = (id) => document.getElementById(id).click()

const STORE_BASE = { coupleId: 'c1', user: { id: 'u1' }, partner: { user_id: 'u2', nickname: '宝贝' } }

let root = null
async function mount(activeTab) {
  if (root) {
    root.unmount()
    await tick(30)
  }
  channelHandlers.length = 0
  const container = document.getElementById('root')
  container.innerHTML = ''
  root = ReactDomClient.createRoot(container)
  root.render(ReactCore.createElement(Harness, { activeTab }))
  await tick(60)
}
const switchTab = async (activeTab) => {
  root.render(ReactCore.createElement(Harness, { activeTab }))
  await tick(60)
}

// ============================================================
console.log('\n场景 1：基线计数 + 红点 + 首页卡片（故意用旧版扁平结构播种 → 顺带验证自动迁移）')

localStorage.clear()
localStorage.setItem(
  'love_unread_v1_u1',
  JSON.stringify({ messages: T0, diary: T0, pokes: T0, mood: { mood: '平静', date: '2026-01-01' }, moodInit: true }),
)
globalThis.__STORE_VALUE__ = STORE_BASE
await mount('home')

{
  const s = probeState()
  ok(s.counts.messages === 3, `留言桶 = 2 条留言 + 1 条回复 = 3（实际 ${s.counts.messages}）`)
  ok(s.counts.diary === 2, `日记评论 = 2（实际 ${s.counts.diary}）`)
  ok(s.counts.chat === true, '想聊聊待处理')
  ok(s.counts.pokes === 2, `普通戳 = 2（自己的不算，实际 ${s.counts.pokes}）`)
  ok(s.counts.mood && s.counts.mood.mood === '开心', '心情提醒：快照(平静)≠最新(开心)')
  ok(s.tabDots.messages === true && s.tabDots.diary === true, '留言/日记页签有红点')
  ok(s.tabDots.messagesPulse === true, '想聊聊 → 留言红点脉冲')
  ok(bodyText().includes('想和你聊聊'), '卡片置顶：TA 想和你聊聊')
  ok(bodyText().includes('3 条新留言'), '卡片：3 条新留言')
  ok(bodyText().includes('2 条新评论'), '卡片：日记 2 条新评论')
  ok(bodyText().includes('戳了戳你'), '卡片：戳了戳你')
  ok(bodyText().includes('心情：'), '卡片：心情提醒')
  const dots = [...document.querySelectorAll('.bg-red-500')]
  ok(dots.length === 2, `TabBar 渲染 2 个红点（实际 ${dots.length}）`)
  ok(document.querySelector('.animate-ping.rounded-full.bg-red-400'), '想聊聊红点带脉冲动画')
}

console.log('\n场景 2：进入留言页自动清除')

await switchTab('messages')
{
  const s = probeState()
  ok(s.counts.messages === 0 && s.counts.chat === false && s.counts.pokes === 0, '进入留言页：留言/想聊聊/戳一戳全清')
  ok(s.counts.diary === 2, '日记评论不受影响')
  const rec = JSON.parse(localStorage.getItem('love_unread_v1_u1'))
  ok(rec.couples && rec.couples.c1, '旧版扁平基线已迁移为「按空间嵌套」结构')
  ok(rec.couples.c1.messages > T0 && rec.couples.c1.pokes > T0, '基线已吸收写回 localStorage')
}

await switchTab('home')
{
  const s = probeState()
  ok(s.counts.messages === 0 && s.counts.chat === false, '离开留言页后仍为 0（看过就是看过）')
  ok(s.counts.diary === 2, '日记评论保留')
}

console.log('\n场景 3：实时事件增量（防抖重查）')

db.messages.push({ id: 'm4', couple_id: 'c1', author_user_id: 'u2', content: '新留言', created_at: new Date().toISOString() })
globalThis.__UNREAD_TRIGGER__('messages', db.messages[db.messages.length - 1])
await sleep(1000)
{
  const s = probeState()
  ok(s.counts.messages === 1, `实时新留言 → 未读 +1（实际 ${s.counts.messages}）`)
  ok(bodyText().includes('1 条新留言'), '首页卡片同步出现')
}

console.log('\n场景 4：心情更新 → 提醒 → markSeen')

db.moods[0].mood = '难过'
globalThis.__UNREAD_TRIGGER__('moods', db.moods[0])
await sleep(1000)
{
  const s = probeState()
  ok(s.counts.mood && s.counts.mood.mood === '难过', '同一天改心情值 → 触发提醒（难过）')
  clickBtn('seen-mood')
  await tick(30)
  ok(probeState().counts.mood === null, '点条目 markSeen → 提醒清除')
  const saved = JSON.parse(localStorage.getItem('love_unread_v1_u1')).couples.c1
  ok(saved.mood && saved.mood.mood === '难过', '快照已更新到 localStorage')
}

console.log('\n场景 5：戳一戳 toast 已看广播（unread:seen）')

db.pokes.push({ id: 'p5', couple_id: 'c1', from_user_id: 'u2', kind: 'poke', created_at: new Date().toISOString() })
globalThis.__UNREAD_TRIGGER__('pokes', db.pokes[db.pokes.length - 1])
await sleep(1000)
ok(probeState().counts.pokes === 1, '新戳 → 卡片 +1')
window.dispatchEvent(new CustomEvent('unread:seen', { detail: 'pokes' }))
await tick(30)
ok(probeState().counts.pokes === 0, 'PokeListener 的已看广播 → 自动清除')

console.log('\n场景 6：进入日记页清除')

await switchTab('diary')
await tick(30)
ok(probeState().counts.diary === 0, '进入日记页 → 评论未读清零')

console.log('\n场景 7：首次使用（无基线）——老内容不淹没，心情静默初始化')

localStorage.clear() // 模拟全新设备/清空浏览器数据
await mount('home')
{
  const s = probeState()
  ok(s.counts.messages === 0 && s.counts.diary === 0 && s.counts.chat === false && s.counts.pokes === 0, `首跑全零（基线=现在）[${JSON.stringify(s.counts)}]`)
  ok(s.counts.mood === null, '首跑心情不提醒')
  const saved = JSON.parse(localStorage.getItem('love_unread_v1_u1')).couples.c1
  ok(saved.moodInit === true && saved.mood && saved.mood.mood === '难过', '心情快照已静默写入')
  ok(!bodyText().includes('TA 的新动态'), '无新动态 → 卡片不渲染')
}

console.log('\n场景 8：单人空间（无 partner）——卡片消失、不查心情')

globalThis.__STORE_VALUE__ = { ...STORE_BASE, partner: null }
await mount('home')
{
  const saved = JSON.parse(localStorage.getItem('love_unread_v1_u1')).couples.c1
  ok(!bodyText().includes('TA 的新动态'), '无 partner → 卡片不渲染')
  ok(saved.moodInit === true, '不影响已有快照')
}

console.log('\n场景 9：换空间（同一用户、coupleId 变化）——基线按空间隔离')

// 切走前先给 c1 造一条未读（后面的隔离断言靠它区分「恢复 c1 状态」和「c2 泄漏」）
db.messages.push({ id: 'm8', couple_id: 'c1', author_user_id: 'u2', content: 'c1 新留言', created_at: new Date().toISOString() })
globalThis.__UNREAD_TRIGGER__('messages', db.messages[db.messages.length - 1])
await sleep(1000)
ok(probeState().counts.messages === 1, '切走前：c1 有 1 条未读')

// c2 空间的旧内容（对方发的，时间很早）
db.messages.push({ id: 'm9', couple_id: 'c2', author_user_id: 'u2', content: 'c2 老留言', created_at: OLD })

// 退出 c1、加入 c2
globalThis.__STORE_VALUE__ = { coupleId: 'c2', user: { id: 'u1' }, partner: { user_id: 'u2', nickname: '新宝贝' } }
await mount('home')
{
  const s = probeState()
  ok(s.counts.messages === 0 && s.counts.chat === false && s.counts.pokes === 0, '新空间首跑：c2 旧内容不淹没（基线=现在）')
  const rec = JSON.parse(localStorage.getItem('love_unread_v1_u1'))
  ok(rec.couples.c1 && rec.couples.c2, '两个空间的基线并存（c1 不被覆盖）')
}

// c2 来新动态：2 条留言 + 1 个想聊聊 → 只算在 c2 头上
db.messages.push(
  { id: 'm10', couple_id: 'c2', author_user_id: 'u2', content: 'c2 新留言1', created_at: new Date().toISOString() },
  { id: 'm11', couple_id: 'c2', author_user_id: 'u2', content: 'c2 新留言2', created_at: new Date().toISOString() },
)
db.pokes.push({ id: 'p9', couple_id: 'c2', from_user_id: 'u2', kind: 'chat', created_at: new Date().toISOString() })
globalThis.__UNREAD_TRIGGER__('messages', db.messages[db.messages.length - 1])
globalThis.__UNREAD_TRIGGER__('pokes', db.pokes[db.pokes.length - 1])
await sleep(1000)
{
  const s = probeState()
  ok(s.counts.messages === 2 && s.counts.chat === true, `c2 新动态 → c2 未读 +2/+想聊聊（实际 ${JSON.stringify(s.counts)}）`)
}

// 切回 c1：恢复 c1 自己的未读状态（m8 还没看 = 1 条；c2 的 2 条不会漏过来）
globalThis.__STORE_VALUE__ = STORE_BASE
await mount('home')
{
  const s = probeState()
  ok(s.counts.messages === 1 && s.counts.chat === false, `切回 c1 → 恢复 c1 状态（messages=1 不受 c2 的 2 条影响）[${JSON.stringify(s.counts)}]`)
}

// 再切到 c2：c2 的未读原样保留（c1 期间没有"看过"它）
globalThis.__STORE_VALUE__ = { coupleId: 'c2', user: { id: 'u1' }, partner: { user_id: 'u2', nickname: '新宝贝' } }
await mount('home')
{
  const s = probeState()
  ok(s.counts.messages === 2 && s.counts.chat === true, `再切回 c2 → 未读保留（不丢不串）[${JSON.stringify(s.counts)}]`)
}

// ---------- 结果 ----------
console.log(`\n结果：${pass} 通过${fails.length ? `，${fails.length} 失败` : '，0 失败'}`)
for (const f of fails) console.log('  ✗ ' + f)
if (root) {
  root.unmount()
  await tick(20)
}
process.exit(fails.length ? 1 : 0)
