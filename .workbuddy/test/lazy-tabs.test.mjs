// 页面级代码分包（懒加载）：源码扫描防回归
// 规则：Dashboard 首页 eager，其余 5 页签 lazy 分包 + Suspense 兜底 + 空闲预热；
//       SmartImg 保持图片级懒加载默认开启
import { readFileSync } from 'node:fs'

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

const dash = readFileSync('D:/love/src/views/Dashboard.jsx', 'utf8')
const smart = readFileSync('D:/love/src/components/SmartImg.jsx', 'utf8')

// 1. 首页 eager（首屏不等分包）
ok(/import Home from '\.\/Home\.jsx'/.test(dash), '首页静态引入（首屏零延迟）')
ok(!/lazy\(\(\) => import\('\.\/Home\.jsx'\)\)/.test(dash), '首页不走 lazy')

// 2. 其余 5 个页签全部 lazy 分包
const lazyViews = dash.match(/lazy\(\(\) => import\('\.\/\w+\.jsx'\)\)/g) || []
ok(lazyViews.length === 5, `5 个页签 lazy 分包（实际 ${lazyViews.length}）`)
for (const v of ['Diary', 'Photos', 'Peace', 'Messages', 'Period']) {
  ok(lazyViews.some((s) => s.includes(v)), `${v} 已 lazy`)
}

// 3. Suspense 兜底 + 预热
ok(/<Suspense fallback=\{<TabFallback \/>\}>/.test(dash), '页签容器有 Suspense 兜底')
ok(/function TabFallback\(\)/.test(dash), '加载占位组件存在')
ok(/requestIdleCallback/.test(dash) && /setTimeout\(warm, 2500\)/.test(dash), '空闲预热（requestIdleCallback + 老浏览器兜底）')
const warmBody = dash.match(/const warm = \(\) => \{[\s\S]*?\n  \}/)
ok(!!warmBody && (warmBody[0].match(/import\('\.\//g) || []).length === 5, '预热覆盖全部 5 个分包')
ok(/cancelIdleCallback/.test(dash) && /clearTimeout\(t\)/.test(dash), '卸载时取消预热任务')

// 4. 页签保活逻辑未被破坏（visited 常驻 + hidden 隐藏）
ok(/visited\.map\(\(k\) =>/.test(dash) && /tab === k \? '' : 'hidden'/.test(dash), '页签保活（visited + hidden）逻辑保留')

// 5. 图片级懒加载仍在（SmartImg 默认 lazy，大图显式 eager）
ok(/loading=\{eager \? 'eager' : 'lazy'\}/.test(smart), 'SmartImg 默认 loading=lazy 保留')
ok(/decoding="async"/.test(smart), 'SmartImg 异步解码保留')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exit(1)
