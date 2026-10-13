// TrashModal「清空全部」+ Photos 回收站交互改进的冒烟测试
//   A. jsdom 渲染：清空全部按钮按需出现/防连点/旧用法兼容；恢复/彻底删除回调正常
//   B. 源码扫描：Photos.purgeItem 不再关弹窗；purgeAll 存在且防重防连点；接线与二次确认齐全
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { photoSrc } from './photo-src.mjs'
const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')

let pass = 0
const failures = []
const ok = (cond, name) => { cond ? (pass++, console.log('  ✓', name)) : (failures.push(name), console.log('  ✗', name)) }

// ---------- A. jsdom 渲染 ----------
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
const { window } = dom
for (const k of ['window', 'document', 'CustomEvent', 'location', 'requestAnimationFrame', 'getComputedStyle', 'MutationObserver']) if (window[k] !== undefined) globalThis[k] = window[k]
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })

const out = 'D:/love/.workbuddy/test/trash-modal.bundle.cjs'
// react/react-dom 与组件一起 inline 进 bundle，保证单实例（盘符大小写会分裂 require 缓存）
await esbuild.build({ entryPoints: ['D:/love/.workbuddy/test/trash-modal.entry.jsx'], bundle: true, format: 'cjs', jsx: 'automatic', platform: 'node', outfile: out })
const { React, createRoot, TrashModal } = require(out)

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const root = createRoot(document.getElementById('root'))
const btns = () => [...document.querySelectorAll('button')]
const btnByLabel = (t) => btns().find((b) => b.textContent.includes(t))
const items = [
  { id: 'p1', deletedAt: new Date().toISOString(), kind: 'photo', photo: { id: 'p1', caption: '海滩' } },
  { id: 'a1', deletedAt: new Date().toISOString(), kind: 'album', album: { id: 'a1', name: '旅行' } },
]

// 1. 传 onPurgeAll：显示「清空全部」，点击回调
let purgedAll = 0
root.render(
  React.createElement(TrashModal, {
    open: true, onClose: () => {}, items, onPurgeAll: () => purgedAll++, onPurge: () => {}, onRestore: () => {},
    renderItem: (it) => React.createElement('span', null, it.kind === 'photo' ? it.photo.caption : it.album.name),
  }),
)
await tick(50)
const clearBtn = btnByLabel('清空全部')
ok(!!clearBtn, '传入 onPurgeAll 时显示「清空全部」按钮')
clearBtn?.click(); await tick(30)
ok(purgedAll === 1, '点击「清空全部」触发 onPurgeAll 回调')

// 2. purgingAll=true：按钮禁用 + 文案变化（防连点）
root.render(
  React.createElement(TrashModal, {
    open: true, onClose: () => {}, items, onPurgeAll: () => {}, onPurge: () => {}, onRestore: () => {},
    purgingAll: true,
    renderItem: () => null,
  }),
)
await tick(50)
const busyBtn = btnByLabel('清空中')
ok(!!busyBtn && busyBtn.disabled, 'purgingAll 时按钮显示「清空中…」且禁用')

// 3. 不传 onPurgeAll：无按钮（Diary/Messages 旧用法零影响）
root.render(
  React.createElement(TrashModal, {
    open: true, onClose: () => {}, items, onPurge: () => {}, onRestore: () => {},
    renderItem: () => null,
  }),
)
await tick(50)
ok(!btnByLabel('清空全部') && !btnByLabel('清空中'), '不传 onPurgeAll 时不显示按钮（旧用法兼容）')

// 4. items 为空：即使传了 onPurgeAll 也不显示按钮（空态无东西可清）
root.render(
  React.createElement(TrashModal, {
    open: true, onClose: () => {}, items: [], onPurgeAll: () => {}, onPurge: () => {}, onRestore: () => {},
    renderItem: () => null,
  }),
)
await tick(50)
ok(!btnByLabel('清空全部') && document.body.textContent.includes('最近删除是空的'), '空列表不显示清空按钮')

// 5. 单条「彻底删除」「恢复」回调不受影响
let purgedItem = null
let restoredItem = null
root.render(
  React.createElement(TrashModal, {
    open: true, onClose: () => {}, items, onPurgeAll: () => {},
    onPurge: (it) => { purgedItem = it.id }, onRestore: (it) => { restoredItem = it.id },
    renderItem: () => null,
  }),
)
await tick(50)
btnByLabel('彻底删除')?.click(); await tick(30)
btnByLabel('恢复')?.click(); await tick(30)
ok(purgedItem === 'p1' && restoredItem === 'p1', '单条彻底删除/恢复回调正常')

// ---------- B. Photos.jsx 源码扫描 ----------
console.log('\nB. Photos.jsx 源码扫描')
// Photos.jsx 已拆成 src/views/photos/ 多模块，扫描要覆盖整个目录
const src = photoSrc()

const purgeFn = src.match(/const purgeItem = async [\s\S]*?\r?\n  \}\r?\n/)
ok(!!purgeFn && !purgeFn[0].includes('setTrashOpen'), 'purgeItem 不再关闭回收站弹窗（删完可继续操作）')
ok(!!purgeFn && purgeFn[0].includes('reload()'), 'purgeItem 删除后刷新数据（列表即时减少）')

const purgeAllFn = src.match(/const purgeAll = async [\s\S]*?\r?\n  \}\r?\n/)
ok(!!purgeAllFn, 'purgeAll 一键清空函数存在')
ok(!!purgeAllFn && purgeAllFn[0].includes('for (const item of trashItems)'), 'purgeAll 遍历全部回收站条目')
ok(!!purgeAllFn && purgeAllFn[0].includes('purgedRef.current.has'), 'purgeAll 复用 purgedRef 防重复删除')
ok(!!purgeAllFn && purgeAllFn[0].includes("from('photos').remove"), 'purgeAll 连原图文件一起删')
ok(!!purgeAllFn && purgeAllFn[0].includes('setPurgingAll(false)'), 'purgeAll 结束后复位防连点状态')

ok(/const \[purgeAllConfirm, setPurgeAllConfirm\] = useState\(false\)/.test(src), '清空二次确认状态存在')
ok(/onPurgeAll=\{setPurgeAllConfirm\}/.test(src) && /purgingAll=\{purgingAll\}/.test(src), 'TrashModal 已接清空全部/防连点')
ok(/title="清空最近删除？"/.test(src) && /confirmLabel="全部彻底删除"/.test(src), '清空前有不可恢复警告的二次确认')

const tsrc = readFileSync('D:/love/src/components/TrashModal.jsx', 'utf8')
ok(/onPurgeAll && items\.length > 0/.test(tsrc), 'TrashModal 空列表不显示清空按钮')
ok(/purgingAll \? '清空中…' : '🧹 清空全部'/.test(tsrc), 'TrashModal 按钮文案随 purgingAll 切换')

console.log(`\n========== 结果：${pass} 通过 / ${failures.length} 失败 ==========`)
if (failures.length) { failures.forEach((f) => console.log(' -', f)); process.exit(1) }
