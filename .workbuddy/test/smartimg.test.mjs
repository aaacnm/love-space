// SmartImg 冒烟：重试降级链（缩图→原图→防缓存）与失败占位/重置
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')

let pass = 0
const failures = []
const ok = (cond, name) => { cond ? (pass++, console.log('  ✓', name)) : (failures.push(name), console.log('  ✗', name)) }

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
const { window } = dom
for (const k of ['window', 'document', 'CustomEvent', 'location', 'requestAnimationFrame', 'getComputedStyle', 'MutationObserver']) if (window[k] !== undefined) globalThis[k] = window[k]
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })

const out = 'D:/love/.workbuddy/test/smartimg.bundle.cjs'
// react/react-dom 与组件一起 inline 进 bundle，保证单实例（盘符大小写会分裂 require 缓存）
await esbuild.build({ entryPoints: ['D:/love/.workbuddy/test/smartimg.entry.jsx'], bundle: true, format: 'cjs', jsx: 'automatic', platform: 'node', outfile: out })
const { React, createRoot, SmartImg } = require(out)

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const root = createRoot(document.getElementById('root'))
const fireError = () => {
  const img = document.querySelector('img')
  img.dispatchEvent(new window.Event('error', { bubbles: false }))
}

root.render(React.createElement(SmartImg, { src: 'http://x/render/image/public/photos/a.jpg?width=480&quality=70' }))
await tick(50)
ok(document.querySelector('img')?.src.includes('width=480'), '初始加载 CDN 缩图 URL')

fireError(); await tick(40)
ok(document.querySelector('img')?.src === 'http://x/render/image/public/photos/a.jpg' || document.querySelector('img')?.src.includes('a.jpg'), '第 1 次失败 → 退回原图 URL（去参数）')
ok(!document.querySelector('img')?.src.includes('width=480'), '不再带变换参数')

fireError(); await tick(40)
ok(document.querySelector('img')?.src.includes('r='), '第 2 次失败 → 原图 + 防缓存参数')

fireError(); await tick(40)
ok(!document.querySelector('img') && document.body.textContent.includes('🥀'), '第 3 次失败 → 显示占位块')

document.querySelector('[role="button"]').click(); await tick(40)
ok(document.querySelector('img')?.src.includes('width=480'), '点击占位 → 重置回缩图重试')

console.log(`\n========== 结果：${pass} 通过 / ${failures.length} 失败 ==========`)
if (failures.length) { failures.forEach((f) => console.log(' -', f)); process.exit(1) }
