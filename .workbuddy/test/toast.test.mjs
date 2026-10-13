/**
 * 统一提示（Toast）专项测试
 *   1. 四类提示渲染：success / error / warning 文案与 data-type 正确（loading 单独测）
 *   2. loading 常驻不自动消失，update 成终态后才消失（上传中 → 完成）
 *   3. 自定义 duration 自动消失
 *   4. 同屏最多 4 条，超出挤掉最老的（防批量失败刷屏）
 *   5. 手动关闭按钮 / clear 全清
 *   6. 没有 ToastProvider 时兜底挂载（提示不会凭空消失）
 *   7. 挂了 Provider 后兜底 root 被撤掉，同一条提示不会渲染两份
 *
 * 用法：NODE_PATH=<workspace>/node_modules node toast.test.mjs
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
global.requestAnimationFrame = (cb) => setTimeout(cb, 0)
global.cancelAnimationFrame = (id) => clearTimeout(id)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tick = (ms = 40) => sleep(ms)

// ---------- 打包 harness ----------
const testDir = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(testDir, 'toast.bundle.cjs')
await esbuild.build({
  entryPoints: [path.join(testDir, 'toast-entry.jsx')],
  bundle: true,
  write: true,
  format: 'cjs',
  jsx: 'automatic',
  platform: 'node',
  packages: 'external',
  define: { 'import.meta.env': '{}' },
  outfile: out,
})
const bundle = require(out)

const ReactCore = require('react')
const ReactDomClient = require('react-dom/client')

// ---------- 断言工具 ----------
let pass = 0
const fail = []
const ok = (cond, msg) => {
  if (cond) {
    pass++
    console.log('  ✓ ' + msg)
  } else {
    fail.push(msg)
    console.log('  ✗ ' + msg)
  }
}
const items = () => [...document.querySelectorAll('[data-toast-item]')]
const texts = () => items().map((el) => el.textContent || '')
const types = () => items().map((el) => el.getAttribute('data-type'))
const api = () => window.__api

// ---------- 挂载：故意不挂 Provider，验证兜底 ----------
console.log('\n场景 A：无 Provider 时兜底挂载 + 四类提示')
let root = ReactDomClient.createRoot(document.getElementById('root'))
root.render(ReactCore.createElement(bundle.default))
await tick(60)
ok(!!api(), 'harness 已挂载')
ok(!document.querySelector('[data-toast-root]'), 'A0 还没触发提示：DOM 里没有 toast 容器')

api().success()
api().error()
api().warning()
await tick(60)
ok(items().length === 3, `A1 三类提示各渲染一条（实际 ${items().length}）`)
ok(
  types().join(',') === 'success,error,warning',
  `A2 data-type 依次为 success/error/warning（实际 ${types().join(',')}）`,
)
ok(
  texts().some((t) => t.includes('保存成功')) &&
    texts().some((t) => t.includes('删除失败：boom')) &&
    texts().some((t) => t.includes('请先执行迁移脚本')),
  'A3 三类文案都渲染出来了',
)
ok(!!document.querySelector('[data-toast-fallback]'), 'A4 没挂 Provider 时兜底 root 自动创建')

console.log('\n场景 B：loading 常驻 → update 成终态')
api().clear()
api().loading()
await tick(60)
ok(items().length === 1 && types()[0] === 'loading', 'B1 loading 提示已渲染')
await tick(3200) // 超过 success 默认 2600ms：证明 loading 不会被自动收掉
ok(types()[0] === 'loading', 'B2 loading 等 3.2s 后仍在（常驻，不自动消失）')
const lid = api().lastId()
ok(typeof lid === 'number', 'B3 loading 返回可用于收尾的 id')
api().finish('success')
await tick(60)
ok(types()[0] === 'success' && texts()[0].includes('上传完成'), 'B4 update 后就地变成 success 文案')
await tick(3000)
ok(items().length === 0, 'B5 终态 success 到时自动消失')

console.log('\n场景 C：自定义 duration 自动消失')
api().clear()
api().short()
await tick(60)
ok(items().length === 1, 'C1 短命提示已出现')
await tick(400)
ok(items().length === 0, 'C2 150ms 后自动消失')

console.log('\n场景 D：同屏上限 4 条（挤掉最老的）')
api().clear()
api().many()
await tick(60)
ok(items().length === 4, `D1 连发 6 条只保留 4 条（实际 ${items().length}）`)
ok(
  texts().every((t) => !t.includes('第 1 条')) && texts().every((t) => !t.includes('第 2 条')),
  `D2 挤掉的是最老的两条（实际 ${JSON.stringify(texts())}）`,
)

console.log('\n场景 E：手动关闭 / 全清')
api().clear()
api().success()
await tick(60)
const closeBtn = items()[0].querySelector('button')
ok(!!closeBtn, 'E1 每条都带关闭按钮')
closeBtn.click()
await tick(60)
ok(items().length === 0, 'E2 点关闭后该条消失')
api().success()
api().warning()
await tick(60)
ok(items().length === 2, 'E3 再次渲染两条')
api().clear()
await tick(60)
ok(items().length === 0, 'E4 clear 全清')

console.log('\n场景 F：挂了 Provider 后兜底 root 撤掉（不重复渲染）')
root.unmount()
await tick(60)
root = ReactDomClient.createRoot(document.getElementById('root'))
root.render(ReactCore.createElement(bundle.HarnessWithProvider))
await tick(60)
api().success()
await tick(80)
ok(!!document.querySelector('[data-toast-root]'), 'F1 Provider 渲染出 toast 容器')
ok(!document.querySelector('[data-toast-fallback]'), 'F2 兜底 root 已撤掉')
ok(items().length === 1, `F3 同一条提示只渲染一份（实际 ${items().length}）`)

root.unmount()
await tick(60)

console.log(`\n========== 结果：${pass} 通过 / ${fail.length} 失败 ==========`)
if (fail.length) {
  console.log('FAILED:\n' + fail.join('\n'))
  process.exit(1)
}
