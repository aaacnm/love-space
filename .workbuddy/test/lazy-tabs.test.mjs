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
const loaders = readFileSync('D:/love/src/views/tabLoaders.js', 'utf8')
const prefetch = readFileSync('D:/love/src/views/tabPrefetch.js', 'utf8')
const bar = readFileSync('D:/love/src/components/TabBar.jsx', 'utf8')
const smart = readFileSync('D:/love/src/components/SmartImg.jsx', 'utf8')

// 1. 首页 eager（首屏不等分包）
ok(/import Home from '\.\/Home\.jsx'/.test(dash), '首页静态引入（首屏零延迟）')
ok(!/lazy\(\(\) => import\('\.\/Home\.jsx'\)\)/.test(dash), '首页不走 lazy')

// 2. 其余 5 个页签全部 lazy 分包；入口集中在 tabLoaders.js，lazy 与预加载共用一份
const lazyViews = dash.match(/lazy\(TAB_LOADERS\.\w+\)/g) || []
ok(lazyViews.length === 5, `5 个页签 lazy 分包（实际 ${lazyViews.length}）`)
for (const v of ['diary', 'photos', 'peace', 'messages', 'period']) {
  ok(lazyViews.includes(`lazy(TAB_LOADERS.${v})`), `${v} 已 lazy`)
}
ok((loaders.match(/import\('\.\/\w+\.jsx'\)/g) || []).length === 5, 'tabLoaders.js 有 5 个动态 import')
ok(!/import\('\.\//.test(dash), 'Dashboard.jsx 不再自带动态 import（入口只有一处）')

// 3. Suspense 兜底 + 预热
ok(/<Suspense fallback=\{<TabFallback \/>\}>/.test(dash), '页签容器有 Suspense 兜底')
ok(/function TabFallback\(\)/.test(dash), '加载占位组件存在')
ok(/requestIdleCallback/.test(dash) && /setTimeout\(warm, 2500\)/.test(dash), '空闲预热（requestIdleCallback + 老浏览器兜底）')
ok(/cancelIdleCallback/.test(dash) && /clearTimeout\(t\)/.test(dash), '卸载时取消预热任务')

// 3b. 预热纪律（2026-10-16 改）：弱网/省流不预热，且后台最多只拉一个
ok(/if \(!networkCheap\(\)\) return/.test(dash), '后台预热先看网络条件')
ok(/const target = mostLikelyTab\(\)/.test(dash), '后台只挑一个目标（按历史点击预测）')
ok(/const warm = \(\) => \{\s*prefetchTab\(target\)\s*\}/.test(dash), 'warm 里只有一个 prefetchTab')
ok(/if \(!target\) return/.test(dash), '没有历史时不瞎猜，直接不预热')
ok(/saveData/.test(prefetch) && /slow-2g/.test(prefetch), '网络门槛覆盖 saveData 与 2g')
ok(/loader\(\)/.test(prefetch) && /loadedTabs/.test(prefetch), '预加载幂等且失败可重试')
ok(/onPointerDown=\{\(\) => onPrefetch\?\.\(t\.key\)\}/.test(bar), 'TabBar 按下即预加载对应分包')
ok(/onPrefetch=\{prefetchTab\}/.test(dash), 'Dashboard 已把预加载接到 TabBar')

// 4. 页签保活逻辑未被破坏（visited 常驻 + hidden 隐藏）
ok(/visited\.map\(\(k\) =>/.test(dash) && /tab === k \? '' : 'hidden'/.test(dash), '页签保活（visited + hidden）逻辑保留')

// 5. 图片级懒加载仍在（SmartImg 默认 lazy，大图显式 eager）
// 默认 lazy；首屏第一张传 priority 时才 eager（并且是全图唯一的 high）
ok(
  /loading=\{priority \|\| eager \? 'eager' : 'lazy'\}/.test(smart),
  'SmartImg 默认 loading=lazy、priority 时 eager 保留',
)
ok(/fetchpriority: 'high'/.test(smart), '首图 priority → fetchpriority=high')
ok(/decoding="async"/.test(smart), 'SmartImg 异步解码保留')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exit(1)
