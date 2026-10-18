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
// 重试语义（2026-10 改）：**绝不去掉 query**。签名 token 与变换参数都在 query 里，
// 砍掉就是 403；而且对缩略图来说「去参数」等于退回原图，一次重试吃掉几 MB。
// 现在每次重试只是在末尾加防缓存参数 _r=。
ok(document.querySelector('img')?.src.includes('width=480'), '第 1 次失败仍保留签名/变换参数（去参数必 403）')
ok(document.querySelector('img')?.src.includes('_r='), '第 1 次失败 → 加防缓存参数重试')

fireError(); await tick(40)
ok(document.querySelector('img')?.src.includes('r='), '第 2 次失败 → 原图 + 防缓存参数')

fireError(); await tick(40)
ok(!document.querySelector('img') && document.body.textContent.includes('🥀'), '第 3 次失败 → 显示占位块')

document.querySelector('[role="button"]').click(); await tick(40)
ok(document.querySelector('img')?.src.includes('width=480'), '点击占位 → 重置回缩图重试')

console.log(`\n========== 结果：${pass} 通过 / ${failures.length} 失败 ==========`)
if (failures.length) { failures.forEach((f) => console.log(' -', f)); process.exit(1) }
