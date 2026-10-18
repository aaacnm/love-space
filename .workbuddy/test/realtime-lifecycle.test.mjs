/**
 * Realtime 生命周期与 DELETE 过滤测试
 *   1. 挂载即订阅：1 次查询 + 1 条 channel + DELETE 兜底监听就位
 *   2. DELETE 精准过滤：非本空间删除（old.couple_id 不同）不触发刷新；
 *      本空间删除 / 旧行无 couple_id（只有主键）保守刷新（不漏刷）
 *   3. 隐藏 tab 暂停：TabActiveContext=false → removeChannel、visibilitychange 不再拉数据
 *   4. 切回自动恢复：重新订阅 + 自动补拉一次
 *   5. enabled=false：整体停用（不查询不订阅），恢复后同样自动补拉
 *   6. Dashboard.jsx 已按 tab 可见性用 TabActiveContext.Provider 包裹，全局组件在外层不受影响
 *
 * 用法：NODE_PATH=<workspace>/node_modules node realtime-lifecycle.test.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')
import fs from 'node:fs'
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

// ---------- supabase stub：记录查询/订阅/移除，捕获 DELETE 兜底回调 ----------
const log = { select: 0, channels: [], removed: 0 }
// 每条 channel 捕获两条监听（都按表登记）：
//   mainHandlers  —— event:'*' 带 couple_id 过滤的主监听（服务端只推本空间变更）
//   deleteHandlers —— event:'DELETE' 不带过滤的兜底（旧行只有主键时也认得出来）
const mainHandlers = []
const deleteHandlers = []
let selectSeq = 0

const supabase = {
  from: () => {
    const q = {}
    q.select = () => {
      selectSeq++
      log.select++
      return q
    }
    q.eq = () => q
    q.order = () => q
    q.then = (res) => res({ data: [{ id: `row-${selectSeq}`, couple_id: 'c1' }], error: null })
    return q
  },
  // ⚠ 现在全 App 对一个空间只建一条 channel（lib/realtimeBus.js），
  //    一条 channel 上会为每张表各登记一条 DELETE 兜底监听，所以回调要按表取。
  channel: (name) => {
    const ch = {}
    const mains = []
    const dels = []
    ch.on = (event, cfg, cb) => {
      if (event !== 'postgres_changes') return ch
      if (cfg?.event === 'DELETE') dels.push({ table: cfg.table, cb })
      else mains.push({ table: cfg.table, cb })
      return ch
    }
    ch.subscribe = () => ch
    log.channels.push(name)
    mainHandlers.push(mains)
    deleteHandlers.push(dels)
    return ch
  },
  removeChannel: () => {
    log.removed++
  },
}
globalThis.__SUPABASE_STUB__ = supabase

// ---------- 打包 harness（supabase.js 换 stub，react 等 bare import external） ----------
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
const out = path.join(testDir, 'realtime-lifecycle.bundle.cjs')
await esbuild.build({
  entryPoints: [path.join(testDir, 'realtime-entry.jsx')],
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
const latestHandlers = () => deleteHandlers[deleteHandlers.length - 1]
// 共享频道上按表取回调（本用例订阅的是 photos）
const deleteHandlerOf = (table) => latestHandlers()?.find((h) => h.table === table)?.cb
const mainHandlerOf = (table) => mainHandlers[mainHandlers.length - 1]?.find((h) => h.table === table)?.cb
const probe = () => document.getElementById('probe').textContent

await tick() // 首次挂载：load + subscribe

// ---------- 场景 A：挂载即订阅 ----------
ok(log.select === 1, `A1 挂载拉取一次数据（实际 ${log.select}）`)
ok(log.channels.length === 1, `A2 创建一条 channel（实际 ${log.channels.length}）`)
ok(!!deleteHandlerOf('photos'), 'A3 photos 的 DELETE 兜底监听已注册（共享频道按表登记）')
ok(probe() === '1:false', `A4 数据与加载态就位（实际 ${probe()}）`)

// ---------- 场景 E：DELETE 精准过滤 ----------
const beforeE = log.select
deleteHandlerOf('photos')({ old: { id: 9, couple_id: 'other-space' } })
await tick()
ok(log.select === beforeE, 'E1 非本空间删除不触发刷新（全表无过滤刷新已修复）')
// 本空间删除：由「带 couple_id 过滤的主监听」命中（表设了 REPLICA IDENTITY FULL 时走这条路）
mainHandlerOf('photos')({ eventType: 'DELETE', table: 'photos', old: { id: 8, couple_id: 'c1' } })
await tick()
ok(log.select === beforeE + 1, 'E2 本空间删除触发刷新')
// 同一条删除不该被兜底监听再刷一次（避免一次删除刷两遍）
deleteHandlerOf('photos')({ old: { id: 8, couple_id: 'c1' } })
await tick()
ok(log.select === beforeE + 1, 'E2b 兜底监听不重复刷新（本空间的删除主监听已经刷过）')
// DELETE 默认只带主键：旧行没有 couple_id → 兜底保守刷新
deleteHandlerOf('photos')({ old: { id: 7 } })
await tick()
ok(log.select === beforeE + 2, 'E3 旧行无 couple_id 时保守刷新（不漏刷）')

// ---------- 场景 B：隐藏 tab 暂停 ----------
window.__setActive(false)
await tick()
ok(log.removed === 1, `B1 隐藏后移除 Realtime channel（实际 removed=${log.removed}）`)
const beforeB = log.select
document.dispatchEvent(new dom.window.Event('visibilitychange'))
await tick()
ok(log.select === beforeB, 'B2 隐藏后 visibilitychange 不再拉数据')

// ---------- 场景 C：切回自动恢复 ----------
window.__setActive(true)
await tick()
ok(log.channels.length === 2, `C1 切回重新订阅（实际 ${log.channels.length} 条）`)
ok(log.select === beforeB + 1, `C2 切回自动补拉一次（实际 ${log.select}）`)
ok(!!deleteHandlerOf('photos'), 'C3 新 channel 的 DELETE 监听重新注册（按表登记）')

// ---------- 场景 D：enabled=false 整体停用 ----------
window.__setEnabled(false)
await tick()
ok(log.removed === 2, `D1 enabled=false 移除 channel（实际 removed=${log.removed}）`)
const beforeD = log.select
document.dispatchEvent(new dom.window.Event('visibilitychange'))
await tick()
ok(log.select === beforeD, 'D2 停用后 visibilitychange 不触发查询')
window.__setEnabled(true)
await tick()
ok(log.channels.length === 3, `D3 enabled 恢复重新订阅（实际 ${log.channels.length} 条）`)
ok(log.select === beforeD + 1, `D4 enabled 恢复自动补拉（实际 ${log.select}）`)

// ---------- 场景 F：Dashboard 源码接线 ----------
const dashSrc = fs.readFileSync('D:/love/src/views/Dashboard.jsx', 'utf8')
ok(dashSrc.includes('TabActiveContext.Provider'), 'F1 Dashboard 用 TabActiveContext.Provider 包裹 tab 内容')
ok(dashSrc.includes('value={tab === k}'), 'F2 可见性按当前 tab 判定')
ok(
  dashSrc.indexOf('<TabActiveContext.Provider') > dashSrc.indexOf('<main'),
  'F3 Provider 只包住 tab 内容区（Notifier/PokeListener/TabBar 在外层始终活跃）',
)

// ---------- 汇总 ----------
console.log(`\n结果：${pass} 通过 / ${fail.length} 失败`)
if (fail.length) {
  fail.forEach((m) => console.log('  ✗ ' + m))
  process.exit(1)
}
