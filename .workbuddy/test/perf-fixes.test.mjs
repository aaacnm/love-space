// 性能修复冒烟测试：
// A/B. Diary + Messages 的日期筛选默认今天（iOS 空值白块问题）
// C. Dashboard tab 保活：切走不卸载（hidden）、切回不重新挂载（channel 订阅数不增）
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')

let pass = 0
const failures = []
const ok = (cond, name) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    failures.push(name)
    console.log('  ✗', name)
  }
}

const todayStr = () => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ---------- supabase stub ----------
let channelCount = 0
let removedCount = 0
const makeSupabaseStub = (db) => {
  const chainFor = (table) => {
    const rows = db[table] || []
    const q = {
      select: () => q,
      eq: () => q,
      order: () => q,
      in: () => q,
      single: () => q,
      limit: () => q,
      range: () => q,
      is: () => q,
      then(res, rej) {
        return Promise.resolve({ data: JSON.parse(JSON.stringify(rows)), error: null }).then(res, rej)
      },
    }
    return q
  }
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: (t) => chainFor(t),
    storage: { from: () => ({ getPublicUrl: (p) => ({ data: { publicUrl: 'http://localhost/' + p } }) }) },    storage: {
      from: () => ({
        getPublicUrl: (p) => ({ data: { publicUrl: 'http://localhost/' + p } }),
        createSignedUrl: async (p) => ({ data: { signedUrl: 'http://localhost/sign/' + p } }),
        createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: 'http://localhost/sign/' + p })), error: null }),
      }),
    },
    channel(name) {
      channelCount++
      const ch = {
        on: () => ch,
        subscribe: () => ch,
      }
      ch.name = name
      return ch
    },
    removeChannel: () => {
      removedCount++
    },
    __channelCount: () => channelCount,
    __removedCount: () => removedCount,
  }
}

const storeStub = `
export function StoreProvider({ children }) { return children }
export function useStore() { return globalThis.__STORE__ }
`

const DB = {
  diary_entries: [
    { id: 'd1', couple_id: 'c1', author_user_id: 'u1', content: '昨天的日记', mood: '开心', created_at: new Date(Date.now() - 86400000).toISOString() },
    { id: 'd2', couple_id: 'c1', author_user_id: 'u2', content: '今天的日记', mood: '甜蜜', created_at: new Date().toISOString() },
  ],
  messages: [
    { id: 'msg1', couple_id: 'c1', author_user_id: 'u1', voice_path: 'voice/c1/a.m4a', duration: 3, created_at: new Date().toISOString() },
  ],
  photos: [],
  albums: [],
  delete_requests: [],
  period_logs: [],
  period_settings: [],
  period_daily_logs: [],
  diary_hidden: [],
  message_hidden: [],
  message_comments: [],
  pokes: [],
  milestones: [],
  moods: [],
}

const MEMBERS = [
  { id: 'm1', user_id: 'u1', nickname: '我', emoji: '💕' },
  { id: 'm2', user_id: 'u2', nickname: 'TA', emoji: '🐰' },
]

// ---------- jsdom ----------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const { window } = dom
for (const k of ['window', 'document', 'localStorage', 'CustomEvent', 'location', 'requestAnimationFrame', 'getComputedStyle', 'MutationObserver']) {
  if (window[k] !== undefined) globalThis[k] = window[k]
}
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
function waitFor(fn, name, tries = 60) {
  return new Promise((resolve) => {
    const go = async (n) => {
      if (fn()) return resolve(true)
      if (n <= 0) {
        failures.push('waitFor: ' + name)
        console.log('  ✗ waitFor 超时:', name)
        return resolve(false)
      }
      await tick(25)
      go(n - 1)
    }
    go(tries)
  })
}

const React = require('react')
const ReactDOM = require('react-dom/client')

async function bundle(entry, outfile, extraStubs = []) {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), outfile)
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    jsx: 'automatic',
    platform: 'node',
    packages: 'external',
    define: { 'import.meta.env': '{}' }, // DistanceCard 等读 VITE_ 变量，测试环境给空对象
    outfile: out,
    plugins: [
      {
        name: 'stubs',
        setup(b) {
          b.onResolve({ filter: /supabase\.js$/ }, () => ({ path: 'supa-stub', namespace: 'stub' }))
          b.onResolve({ filter: /store\.jsx$/ }, () => ({ path: 'store-stub', namespace: 'stub' }))
          for (const [filter, source] of extraStubs) {
            b.onResolve({ filter }, () => ({ path: 'x-' + filter, namespace: 'stub' }))
            b.onLoad({ filter: new RegExp('x-' + filter), namespace: 'stub' }, () => ({ contents: source, loader: 'js' }))
          }
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
            contents: args.path === 'supa-stub' ? 'export const supabase = globalThis.__SUPA__' : storeStub,
            loader: 'js',
          }))
        },
      },
    ],
  })
  return require(out)
}

const dateInputs = () => [...document.querySelectorAll('input[type="date"]')]

// ---------- 场景 A：Diary 默认今日 ----------
console.log('\n场景 A：日记日期筛选默认今天')
globalThis.__SUPA__ = makeSupabaseStub(DB)
globalThis.__STORE__ = {
  coupleId: 'c1',
  user: { id: 'u1' },
  members: MEMBERS,
  myMember: MEMBERS[0],
  partner: MEMBERS[1],
  couple: { id: 'c1', code: 'LOVE1' },
  milestones: [],
  refresh: async () => {},
}
const Diary = (await bundle('D:/love/src/views/Diary.jsx', 'perf-diary.bundle.cjs')).default
let root = ReactDOM.createRoot(document.getElementById('root'))
root.render(React.createElement(Diary))
await waitFor(() => dateInputs().length > 0, '日记渲染出日期筛选')
ok(dateInputs()[0].value === todayStr(), `日记日期筛选默认今天（${todayStr()}）`)
ok(document.body.textContent.includes('今天的日记'), '列表默认只显示今天的日记')
ok(!document.body.textContent.includes('昨天的日记'), '昨天的日记被筛掉')
root.unmount()
await tick(40)

// ---------- 场景 B：Messages 默认今日 ----------
console.log('\n场景 B：留言日期筛选默认今天')
document.body.innerHTML = '<div id="root"></div>' // 重建容器（textContent='' 会把 root 一起清掉）
const Messages = (await bundle('D:/love/src/views/Messages.jsx', 'perf-messages.bundle.cjs')).default
root = ReactDOM.createRoot(document.getElementById('root'))
root.render(React.createElement(Messages))
const foundB = await waitFor(() => dateInputs().length > 0, '留言渲染出日期筛选')
if (!foundB) console.log('DEBUG body:', document.body.textContent.slice(0, 400))
ok(dateInputs()[0]?.value === todayStr(), '留言日期筛选默认今天')
root.unmount()
await tick(40)

// ---------- 场景 C：Dashboard tab 保活 ----------
console.log('\n场景 C：Dashboard tab 保活（切走不卸载，切回不重挂）')
document.body.innerHTML = '<div id="root"></div>'
channelCount = 0
removedCount = 0
const Dashboard = (await bundle('D:/love/src/views/Dashboard.jsx', 'perf-dashboard.bundle.cjs')).default
root = ReactDOM.createRoot(document.getElementById('root'))
root.render(React.createElement(Dashboard))
await tick(120)
const channelsAfterHome = channelCount
ok(channelsAfterHome > 0, `首页挂载（${channelsAfterHome} 个 realtime 频道）`)

const tabBtn = (label) => {
  // TabBar 是 fixed/sticky 底栏，先定位它再找按钮，避免撞上页面里的同名文本
  const bar = [...document.querySelectorAll('div')].find((d) => /sticky|fixed/.test(d.className) && d.textContent.includes('生理期'))
  const scope = bar || document
  return [...scope.querySelectorAll('button')].find((b) => b.textContent.replace(/\s/g, '').includes(label))
}
const tabsRoot = [...document.querySelectorAll('div')].find((d) => d.className.includes('sticky')) || document.body
tabBtn('日记').click()
await tick(120)
const diaryStillThere = document.body.textContent.includes('我们的日记')
ok(diaryStillThere, '切到日记 tab 正常显示')

// 隐藏中的 home：Home 的独特文案（比如「我们已经在一起」）应该还在 DOM 里
ok(document.body.textContent.includes('我们已经在一起') || document.body.textContent.includes('编辑我的资料'), '首页仍挂在 DOM（hidden 不卸载）')

// 「我们的日记」标题的最内层元素：用节点引用验证 React 复用同一棵子树（未重挂）。
// 标题可能带 emoji/前后缀，用「包含该文案且文本最短」定位最内层节点
const findDiaryHeading = () => {
  const els = [...document.querySelectorAll('h1,h2,h3,span,div,p')].filter(
    (el) => el.textContent.includes('我们的日记'),
  )
  els.sort((a, b) => a.textContent.length - b.textContent.length)
  return els[0]
}

// 新语义（TabActiveContext）：隐藏 tab 的 Realtime 频道被移除、切回时自动重建，
// 频道创建数不再恒定；「不重新挂载」改用 DOM 节点身份直接验证
const diaryHeading = findDiaryHeading()
const removedAfterFirstDiary = removedCount
ok(removedAfterFirstDiary > 0, `隐藏首页后其 Realtime 频道已移除（隐藏即暂停订阅，removed=${removedAfterFirstDiary}）`)

const channelsAfterDiary = channelCount
tabBtn('首页').click()
await tick(120)
tabBtn('日记').click()
await tick(120)
const diaryHeading2 = findDiaryHeading()
ok(diaryHeading && diaryHeading === diaryHeading2, '切回首页再进日记不重新挂载（DOM 节点身份不变）')
ok(removedCount > removedAfterFirstDiary, `日记隐藏时其频道同样被移除，切回自动重建订阅（removed=${removedAfterFirstDiary} → ${removedCount}）`)
ok(channelCount > channelsAfterDiary, `切回后频道按需重建而非常驻累积（${channelsAfterDiary} → ${channelCount}）`)

root.unmount()
await tick(40)

console.log(`\n========== 结果：${pass} 通过 / ${failures.length} 失败 ==========`)
if (failures.length) {
  console.log('失败项：')
  failures.forEach((f) => console.log(' -', f))
  process.exit(1)
}
