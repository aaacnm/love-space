/**
 * 分页（usePagedCollection）与 LoadMore 组件测试
 *   1. 首屏只拉最近 PAGE_SIZE 条（18，75 条数据），hasMore=true
 *   2. loadMore 增量拉下一页并去重追加；最后一页不满页 → hasMore=false
 *   3. 事件 reload 保留加载深度（不退化回首屏）
 *   4. DELETE 兜底按 old.couple_id 过滤（非本空间不重拉）
 *   5. 隐藏 tab（TabActiveContext=false）移除频道、不再查询
 *   6. loadMore 防重入：并发调用只发一次查询
 *   7. LoadMore 组件：有更多显示按钮、点击回调、无更多显示到底文案、empty 不渲染
 *
 * 用法：NODE_PATH=<workspace>/node_modules node pagination.test.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')
import { fileURLToPath } from 'node:url'
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
global.Node = dom.window.Node
global.Event = dom.window.Event
global.getComputedStyle = dom.window.getComputedStyle
global.requestAnimationFrame = (cb) => setTimeout(cb, 0)
global.cancelAnimationFrame = (id) => clearTimeout(id)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tick = (ms = 30) => sleep(ms)

// ---------- 内存 db + supabase stub（真实 range 窗口语义） ----------
const db = []
for (let i = 0; i < 75; i++) {
  db.push({
    id: `p${String(i).padStart(2, '0')}`,
    couple_id: 'c1',
    label: `photo-${i}`,
    // i 越大越早（desc 排序时 p00 最前）
    created_at: new Date(Date.parse('2026-10-13T00:00:00Z') - i * 60000).toISOString(),
  })
}

const log = { queries: [], channels: 0, removed: 0 }
const deleteHandlers = []

const supabase = {
  from: () => {
    const q = {}
    q.select = () => q
    q.eq = (c, v) => {
      q._eq = { c, v }
      return q
    }
    q.order = () => q // db 已按 created_at desc 构造，双 order no-op
    q.range = (from, to) => {
      q._range = [from, to]
      return q
    }
    q.then = (res, rej) => {
      const rows = db.filter((r) => !q._eq || r[q._eq.c] === q._eq.v)
      const [from, to] = q._range || [0, 29]
      const page = rows.slice(from, to + 1)
      log.queries.push({ from, to, returned: page.length })
      Promise.resolve({ data: page.map((r) => ({ ...r })), error: null }).then(res, rej)
    }
    return q
  },
  // 共享频道（lib/realtimeBus.js）上每条表登记两条监听，都按表记录：
  //   main —— event:'*' 带 couple_id 过滤；del —— event:'DELETE' 不带过滤的兜底
  channel: (name) => {
    log.channels++
    const ch = {}
    const handlers = []
    ch.on = (event, cfg, cb) => {
      if (event === 'postgres_changes' && cfg?.event === 'DELETE') handlers.push({ table: cfg.table, cb })
      else if (event === 'postgres_changes') handlers.push({ table: cfg.table, cb, main: true })
      return ch
    }
    ch.subscribe = () => ch
    deleteHandlers.push(handlers)
    return ch
  },
  removeChannel: () => {
    log.removed++
  },
}
globalThis.__SUPABASE_STUB__ = supabase

// ---------- 打包 ----------
const plugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.path.endsWith('supabase.js')) return { path: 'supa-stub', namespace: 'stub' }
      return null
    })
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const supabase = globalThis.__SUPABASE_STUB__',
      loader: 'js',
    }))
  },
}

const testDir = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(testDir, 'pagination.bundle.cjs')
await esbuild.build({
  entryPoints: [path.join(testDir, 'pagination-entry.jsx')],
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
require(out)

// ---------- 断言工具 ----------
let pass = 0
const fail = []
const ok = (cond, msg) => {
  if (cond) pass++
  else fail.push(msg)
}
const probeText = () => document.getElementById('probe').textContent
const qCount = () => log.queries.length

await tick() // 首屏挂载

// 分页大小直接读源码常量：PAGE_SIZE 调了用例不用改
const PS = window.__pageSize
const TOTAL = 75

// ---------- 场景 A：首屏 PAGE_SIZE 条 ----------
ok(probeText() === `${PS}:true`, `A1 首屏 ${PS} 条且 hasMore（实际 ${probeText()}）`)
ok(
  log.queries.length === 1 && log.queries[0].from === 0 && log.queries[0].to === PS - 1,
  `A2 首屏查询窗口 [0,${PS - 1}]`,
)
ok(window.__probe.rows[0].id === 'p00', 'A3 第一行是最新数据')

// ---------- 场景 B：loadMore 增量 ----------
await window.__probe.loadMore()
await tick()
ok(probeText() === `${2 * PS}:true`, `B1 加载第二页共 ${2 * PS} 条（实际 ${probeText()}）`)
ok(
  log.queries[1].from === PS && log.queries[1].to === 2 * PS - 1,
  `B2 只拉新窗口 [${PS},${2 * PS - 1}]（不重传已加载页）`,
)
ok(window.__probe.rows[2 * PS - 1].id === `p${String(2 * PS - 1).padStart(2, '0')}`, 'B3 追加顺序正确')

// ---------- 场景 C：一直翻到最后一页（不满页 → 到底） ----------
let pages = 2
while (window.__probe.hasMore && pages < 20) {
  await window.__probe.loadMore()
  await tick()
  pages++
  const want = Math.min(pages * PS, TOTAL)
  ok(probeText() === `${want}:${String(want < TOTAL)}`, `C1.${pages} 第 ${pages} 页后 ${want} 条（实际 ${probeText()}）`)
}
ok(probeText() === `${TOTAL}:false`, `C1 全部 ${TOTAL} 条加载完且 hasMore=false（实际 ${probeText()}）`)
const lastQ = log.queries[log.queries.length - 1]
ok(lastQ.returned === TOTAL - (pages - 1) * PS, `C2 最后一页只返回剩余 ${TOTAL - (pages - 1) * PS} 条`)

// ---------- 场景 D：事件 reload 保留深度 ----------
const n0 = qCount()
window.__probe.reload()
await tick()
ok(
  qCount() === n0 + 1 && log.queries[n0].to === pages * PS - 1,
  `D1 reload 按 ${pages} 页深度重拉（窗口 [0,${pages * PS - 1}]，不退化回首屏）`,
)
ok(probeText() === '75:false', 'D2 reload 后数据与状态不变')

// ---------- 场景 E：DELETE 兜底按旧行过滤 ----------
const handlers = deleteHandlers[deleteHandlers.length - 1]
// 本用例订阅的是 photos：兜底监听 vs 带过滤的主监听要分开取
const delOf = (t) => handlers.find((h) => h.table === t && !h.main)?.cb
const mainOf = (t) => handlers.find((h) => h.table === t && h.main)?.cb
const n1 = qCount()
delOf('photos')({ old: { id: 'p01', couple_id: 'other-space' } })
await tick()
ok(qCount() === n1, 'E1 非本空间删除不触发重拉')
mainOf('photos')({ eventType: 'DELETE', table: 'photos', old: { id: 'p01', couple_id: 'c1' } })
await tick()
ok(qCount() === n1 + 1, 'E2 本空间删除触发按深度重拉')
delOf('photos')({ old: { id: 'p01', couple_id: 'c1' } })
await tick()
ok(qCount() === n1 + 1, 'E2b 兜底监听不重复重拉（本空间删除主监听已刷过）')

// ---------- 场景 F：隐藏 tab 暂停 ----------
const removed0 = log.removed
window.__setActive(false)
await tick()
ok(log.removed === removed0 + 1, 'F1 隐藏后移除 Realtime channel')
const n2 = qCount()
window.__probe.reload()
window.__probe.loadMore()
await tick()
ok(qCount() === n2, 'F2 隐藏页 reload/loadMore 均不发查询')
window.__setActive(true)
await tick()
ok(
  qCount() === n2 + 1 && log.queries[n2].to === pages * PS - 1,
  `F3 切回自动按 ${pages} 页深度补拉`,
)

// ---------- 场景 G：loadMore 防重入 ----------
const n3 = qCount()
window.__probe.loadMore() // 不 await，立即第二次
window.__probe.loadMore()
await tick()
await tick()
ok(qCount() === n3, 'G1 hasMore=false 时 loadMore 直接 no-op（75 条已到底）')

// ---------- 场景 H：LoadMore 组件 ----------
const lmBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('加载更多'))
ok(!!lmBtn, 'H1 有更多时渲染「加载更多」按钮')
lmBtn.click()
await tick()
ok(window.__lmCalls === 1, 'H2 点击触发 onLoadMore 回调')
const endText = document.getElementById('lm-end').textContent
ok(endText.includes('到底啦'), 'H3 无更多时显示收尾文案')
ok(document.getElementById('lm-empty').textContent.trim() === '', 'H4 empty 时不渲染任何内容')

// ---------- 汇总 ----------
console.log(`\n结果：${pass} 通过 / ${fail.length} 失败`)
if (fail.length) {
  fail.forEach((m) => console.log('  ✗ ' + m))
  process.exit(1)
}
