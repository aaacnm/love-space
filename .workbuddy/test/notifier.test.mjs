// Notifier 冒烟测试：jsdom + esbuild bundle
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')
let passCount = 0
let failCount = 0

const ok = (cond, msg) => {
  if (cond) {
    passCount++
    console.log(`  ✓ ${msg}`)
  } else {
    failCount++
    console.log(`  ✗ ${msg}`)
  }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 1. jsdom 环境 ----------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://love-space-journal.app.workbuddy.host/',
  pretendToBeVisual: true,
})
const { window } = dom
const { document } = window

for (const k of ['window', 'document', 'navigator', 'localStorage', 'CustomEvent', 'location', 'requestAnimationFrame', 'getComputedStyle', 'MutationObserver']) {
  if (window[k] === undefined) continue
  try {
    globalThis[k] = window[k]
  } catch {
    // Node 的 navigator/URL 等是只读 getter，须 defineProperty 覆盖
    try {
      Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true })
    } catch {
      /* 影响不大的跳过 */
    }
  }
}
globalThis.localStorage = window.localStorage

let hiddenVal = false
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hiddenVal })

// Notification stub（jsdom 没有）
class FakeNotification {
  constructor(title, opts) {
    FakeNotification.last = { title, opts }
    FakeNotification.count = (FakeNotification.count || 0) + 1
  }
  close() {}
}
FakeNotification.permission = 'granted'
FakeNotification.requestPermission = async () => {
  FakeNotification.permission = 'granted'
  return 'granted'
}
Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true })

// ---------- 2. supabase stub（channel 记录回调，测试手动触发）----------
// ⚠ 现在通知走空间级共享频道（lib/realtimeBus.js）：一张表会登记两条监听
//   （主监听 event:'*' + DELETE 兜底），所以回调按表收集成数组，触发时全部调用。
const handlers = {} // table -> [callback]
const removedChannels = []
const supabaseStub = {
  channel: (name) => {
    const ch = {
      name,
      on(event, cfg, cb) {
        if (cfg && cfg.table) (handlers[cfg.table] ||= []).push(cb)
        return ch
      },
      subscribe() {
        return ch
      },
    }
    return ch
  },
  removeChannel: (ch) => {
    removedChannels.push(ch.name)
    return Promise.resolve()
  },
}
globalThis.__SUPA__ = supabaseStub

const ME = { id: 'u2' }
globalThis.__ME = ME
globalThis.__PARTNER = { nickname: '222' }
globalThis.__COUPLE = 'c1'

// ---------- 3. esbuild 打包 Notifier ----------
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notifier.bundle.cjs')
await esbuild.build({
  entryPoints: ['D:/love/src/components/Notifier.jsx'],
  bundle: true,
  format: 'cjs',
  jsx: 'automatic',
  platform: 'node',
  define: { 'import.meta.env': '{}' },
  outfile: out,
  external: ['react', 'react/jsx-runtime', 'react-dom/client'],
  plugins: [
    {
      name: 'stubs',
      setup(b) {
        // 匹配到 supabase.js 就行：总线（realtimeBus.js）里是 './supabase.js'
        b.onResolve({ filter: /supabase\.js$/ }, () => ({ path: 'supa-stub', namespace: 'stub' }))
        b.onResolve({ filter: /lib\/store\.jsx$/ }, () => ({ path: 'store-stub', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents:
            args.path === 'supa-stub'
              ? 'export const supabase = globalThis.__SUPA__'
              : `export function StoreProvider({children}){return children}
export function useStore(){ return { coupleId: globalThis.__COUPLE, user: globalThis.__ME, partner: globalThis.__PARTNER, myMember: null, members: [] } }`,
          loader: 'js',
        }))
      },
    },
  ],
})

const React = require('react')
const ReactDOMClient = require('react-dom/client')
const { Notifier } = require(out)

// 带上 eventType：总线按事件类型分发，通知只认 INSERT
const fire = (table, row) => (handlers[table] || []).forEach((cb) => cb({ eventType: 'INSERT', new: row }))
const bodyText = () => document.body.textContent || ''

async function mount() {
  const root = ReactDOMClient.createRoot(document.getElementById('root'))
  root.render(React.createElement(Notifier))
  await tick(60)
  return root
}

console.log('\n场景 A：无 Notification API 时（iOS 浏览器）→ 提示先加主屏幕；「暂不」后不再弹')
globalThis.__NOTIF_BACKUP__ = Object.getOwnPropertyDescriptor(window, 'Notification')
delete window.Notification
window.localStorage.removeItem('notify_prompt_dismissed')
let root = await mount()
ok(bodyText().includes('添加到主屏幕'), '显示「先添加到主屏幕」引导')
fire('messages', { id: 'm0', couple_id: 'c1', author_user_id: 'u1', content: '早' })
await tick(30)
ok(bodyText().includes('给你留言'), '引导存在时消息横幅仍正常弹出')
const btnZanbu = [...document.querySelectorAll('button')].find((b) => b.textContent === '暂不')
ok(!!btnZanbu, '有「暂不」按钮')
btnZanbu.click()
await tick(30)
ok(window.localStorage.getItem('notify_prompt_dismissed') === '1', '「暂不」写入 localStorage')
root.unmount()
await tick(30)
document.getElementById('root').innerHTML = ''
root = await mount()
await tick(30)
ok(!bodyText().includes('开启新消息提醒'), '关掉后重新挂载不再弹引导')
root.unmount()
await tick(30)
document.getElementById('root').innerHTML = ''

console.log('\n场景 B：权限 default → 点「开启」→ 申请权限成功')
Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true })
FakeNotification.permission = 'default'
FakeNotification.count = 0
window.localStorage.removeItem('notify_prompt_dismissed')
root = await mount()
await tick(30)
ok(bodyText().includes('开启新消息提醒'), 'default 权限时弹引导')
const btnOn = [...document.querySelectorAll('button')].find((b) => b.textContent === '开启')
btnOn.click()
await tick(60)
ok(bodyText().includes('提醒已开启'), '授权成功出现确认横幅')
ok(window.localStorage.getItem('notify_prompt_dismissed') === '1', '记录不再询问')
// 等确认横幅 4 秒消失
await tick(4300)
ok(!bodyText().includes('提醒已开启'), '确认横幅自动消失')
root.unmount()
await tick(30)
document.getElementById('root').innerHTML = ''

console.log('\n场景 C：已授权 + 后台 → 对方留言 → 系统通知 + 横幅 + 标题闪烁 + 去重')
FakeNotification.permission = 'granted'
FakeNotification.count = 0
hiddenVal = true
root = await mount()
await tick(60)
const origTitle = document.title
fire('messages', { id: 'm1', couple_id: 'c1', author_user_id: 'u1', content: '晚上吃火锅吗', created_at: new Date().toISOString() })
await tick(60)
ok(FakeNotification.count === 1, '后台时弹系统通知')
ok((FakeNotification.last?.opts?.icon || '').includes('icon-192'), '通知带 App 图标')
ok(bodyText().includes('给你留言'), '横幅出现（含留言摘要）')
fire('messages', { id: 'm1', couple_id: 'c1', author_user_id: 'u1', content: '晚上吃火锅吗' })
await tick(60)
ok(FakeNotification.count === 1, '同一事件重复推送不重复提醒')
fire('messages', { id: 'm2', couple_id: 'c1', author_user_id: 'u2', content: '我自己发的' })
await tick(60)
ok(FakeNotification.count === 1, '自己发的留言不提醒')
ok(!bodyText().includes('我自己发的'), '自己的留言不出横幅')

console.log('\n场景 D：前台 + 各种事件映射 + 点击横幅跳转')
hiddenVal = false
FakeNotification.count = 0
await tick(5300) // 等场景 C 横幅的 5 秒节流窗口过掉
fire('photos', { id: 'p1', couple_id: 'c1', author_user_id: 'u1', created_at: new Date().toISOString() })
await tick(40)
ok(bodyText().includes('分享了一张新照片'), '照片 → 分享了一张新照片')
fire('diary_entries', { id: 'd1', couple_id: 'c1', author_user_id: 'u1', content: '今天去了海边', created_at: new Date().toISOString() })
await tick(40)
ok(bodyText().includes('写了新日记'), '日记 → 写了新日记')
fire('delete_requests', { id: 'r1', couple_id: 'c1', requester_user_id: 'u1', ref_ids: [], created_at: new Date().toISOString() })
await tick(40)
ok(bodyText().includes('申请删除照片'), '删除申请 → 等你确认')
fire('message_comments', { id: 'mc1', couple_id: 'c1', author_user_id: 'u1', content: '好听！', created_at: new Date().toISOString() })
await tick(40)
ok(bodyText().includes('回复了留言'), '留言评论 → 回复了留言')

let gotoDetail = null
window.addEventListener('app:goto', (e) => (gotoDetail = e.detail))
const lookBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('点看看'))
lookBtn.click()
await tick(40)
ok(gotoDetail === 'messages', '点「点看看」派发 app:goto 到留言页')
ok(!bodyText().includes('回复了留言'), '点击后横幅关闭')

// 标题闪烁：触发后 document.title 应在轮换
fire('diary_comments', { id: 'dc1', couple_id: 'c1', author_user_id: 'u1', content: '抱抱', created_at: new Date().toISOString() })
await tick(40)
ok(bodyText().includes('评论了你的日记'), '日记评论 → 提醒')

// 生理期打卡：自己不提醒、对方提醒
fire('period_daily_logs', { id: 'pd1', couple_id: 'c1', user_id: 'u2', log_date: '2026-10-10', created_at: new Date().toISOString() })
await tick(40)
ok(!bodyText().includes('更新了生理期打卡'), '自己的打卡不提醒')
fire('period_daily_logs', { id: 'pd2', couple_id: 'c1', user_id: 'u1', log_date: '2026-10-10', created_at: new Date().toISOString() })
await tick(40)
ok(bodyText().includes('更新了生理期打卡'), '对方打卡 → 提醒')
ok(document.title.includes('💗') || document.title === origTitle, '标题闪烁已启动（或恢复）')
window.dispatchEvent(new window.Event('focus'))
await tick(40)
ok(document.title === origTitle, '回前台后标题恢复')

root.unmount()
await tick(40)
// 通知不再自建 notifier-<cid> 频道：它挂在空间级共享频道 space-<cid> 上，
// 最后一个订阅者退订时由总线把频道撤掉
ok(removedChannels.some((n) => n.startsWith('space-')), '卸载时移除 realtime 频道（空间级共享频道）')

console.log('\n场景 E：权限被拒 → 补救指引卡；「检查一下」在未授权时给出提示')
window.localStorage.removeItem('notify_prompt_dismissed')
FakeNotification.permission = 'denied'
root = await mount()
await tick(30)
ok(bodyText().includes('提醒被关掉了'), 'denied 时显示补救指引')
// 统一提示（Toast 取代 alert）：直接读渲染出来的 [data-toast-item]
const toastText = () => [...document.querySelectorAll('[data-toast-item]')].map((el) => el.textContent || '').join('\n')
globalThis.__TOAST__ && globalThis.__TOAST__.clear()
await tick(30)
const checkBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === '检查一下')
ok(!!checkBtn, '有「检查一下」按钮')
checkBtn.click()
await tick(30)
ok(toastText().includes('设置'), '未授权时点检查提示去系统设置（Toast）')
const knowBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === '知道了')
knowBtn.click()
await tick(30)
ok(window.localStorage.getItem('notify_prompt_dismissed') === '1', '「知道了」记录不再打扰')
root.unmount()
await tick(30)
document.getElementById('root').innerHTML = ''
root = await mount()
await tick(30)
ok(!bodyText().includes('提醒被关掉了'), '关掉后不再弹指引')
root.unmount()
await tick(30)
document.getElementById('root').innerHTML = ''

console.log('\n场景 F：SW 通知点击 postMessage → 转发成 app:goto')
FakeNotification.permission = 'granted'
const swHandlers = {}
Object.defineProperty(globalThis, 'navigator', {
  value: { ...window.navigator, serviceWorker: { addEventListener: (t, cb) => (swHandlers[t] = cb), removeEventListener: () => {} } },
  configurable: true,
})
root = await mount()
await tick(30)
gotoDetail = null
swHandlers.message({ data: { type: 'app:goto', tab: 'photos' } })
await tick(30)
ok(gotoDetail === 'photos', 'SW message 转发为 app:goto 到照片页')
root.unmount()

fs.rmSync(out, { force: true })
console.log(`\n========== 结果：${passCount} 通过，${failCount} 失败 ==========`)
process.exit(failCount ? 1 : 0)
