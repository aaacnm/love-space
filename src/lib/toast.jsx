/**
 * 全站统一提示（Toast）
 *
 * 背景：项目里同时存在 alert / window.alert / console.error / 页面内 tip 四种反馈方式，
 * 同样的失败在不同页面表现完全不同（有的弹系统框、有的只在控制台、有的完全没提示）。
 * 这里统一成一个入口：所有「要让用户知道」的结果都走 toast，四种类型：
 *   success  成功（绿）
 *   error    失败（红）——同时保留 console.error 便于排查
 *   warning  需要注意 / 引导操作（黄）
 *   loading  进行中（不自动消失，需 dismiss 或 update 成终态）
 *
 * 设计要点：
 * 1. 状态放在模块级单例 store，组件通过订阅渲染。这样 lib/ 下的纯逻辑（非 React）
 *    也能直接 import toast 提示，不必层层传回调。
 * 2. ToastProvider 是「显式挂载点」：App 里挂一次，控制层级与位置。
 *    没挂 Provider 时（例如单测直接渲染某个页面组件）会惰性自动挂载一个兜底 root，
 *    保证提示不会凭空消失——用户永远看得见，测试也能断言到文案。
 * 3. duration=0 表示常驻（loading 默认），必须由调用方 dismiss 或用 update 收尾，
 *    避免「上传中」这类提示卡在屏幕上。
 *
 * 用法：
 *   const t = useToast()            // 组件里
 *   t.success('已保存 ✓')
 *   const id = t.loading('正在上传…'); t.update(id, { type: 'success', text: '上传完成' })
 *   toast.error('删除失败：' + e.message)   // 非组件模块里直接 import toast
 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

// ---------- 模块级 store ----------

const MAX = 4 // 同屏最多 4 条，超了挤掉最老的（防止批量失败刷屏）

let items = []
let seq = 0
// 订阅者分两类：Provider 挂载的正式 viewport，与无 Provider 时的兜底 viewport。
// 判定「有没有 Provider」时必须排除兜底自己，否则它会把自己当成 Provider 拆掉。
const listeners = new Set() // 元素形如 { fn, isFallback }
const timers = new Map()

const notify = () => {
  ;[...listeners].forEach((e) => e.fn())
}

const hasProvider = () => [...listeners].some((e) => !e.isFallback)

export function subscribeToast(fn, isFallback = false) {
  const entry = { fn, isFallback }
  listeners.add(entry)
  return () => listeners.delete(entry)
}

export function getToastItems() {
  return items
}

const DEFAULT_DURATION = {
  success: 2600,
  error: 5000,
  warning: 4000,
  loading: 0, // 常驻
}

function schedule(id, duration) {
  const old = timers.get(id)
  if (old) clearTimeout(old)
  if (duration > 0) timers.set(id, setTimeout(() => api.dismiss(id), duration))
  else timers.delete(id)
}

function dropItem(id) {
  const t = timers.get(id)
  if (t) clearTimeout(t)
  timers.delete(id)
  items = items.filter((it) => it.id !== id)
}

const api = {
  /** 通用入口：返回 id，可用于后续 update / dismiss */
  push(type, text, opts = {}) {
    const id = ++seq
    const duration = opts.duration != null ? opts.duration : DEFAULT_DURATION[type] ?? 3000
    const item = { id, type, text: String(text ?? ''), duration }
    // 超出上限：挤掉最老的（清掉它的定时器，避免幽灵计时）
    while (items.length >= MAX) dropItem(items[0].id)
    items = [...items, item]
    schedule(id, duration)
    notify()
    ensureViewport()
    return id
  },
  success(text, opts) {
    return api.push('success', text, opts)
  },
  error(text, opts) {
    // 失败类同时留一份控制台记录：Toast 给用户看，console 给排查用
    console.error('[toast]', text)
    return api.push('error', text, opts)
  },
  warning(text, opts) {
    return api.push('warning', text, opts)
  },
  /** 进行中：常驻，调用方需 update 成终态或 dismiss */
  loading(text, opts) {
    return api.push('loading', text, opts)
  },
  /** 就地更新（常用于 loading → success/error），duration 缺省按新类型默认值 */
  update(id, patch = {}) {
    const idx = items.findIndex((it) => it.id === id)
    if (idx < 0) return id
    const next = { ...items[idx], ...patch }
    if (patch.type && patch.duration == null) next.duration = DEFAULT_DURATION[patch.type] ?? 3000
    items = items.map((it, i) => (i === idx ? next : it))
    schedule(id, next.duration)
    notify()
    return id
  },
  dismiss(id) {
    dropItem(id)
    notify()
  },
  clear() {
    timers.forEach((t) => clearTimeout(t))
    timers.clear()
    items = []
    notify()
  },
}

export const toast = api

/** 组件里拿 toast：语义与模块单例一致，方便统一改成 useToast() 调用风格 */
export function useToast() {
  return toast
}

// ---------- 调试 / 测试钩子 ----------
// 测试需要在场景之间清空残留提示（单例 store 会跨组件挂载保留），
// 生产环境留着也无害：控制台里可 __TOAST__.clear() 手动清屏。
if (typeof globalThis !== 'undefined') globalThis.__TOAST__ = toast

// ---------- 渲染 ----------

const STYLE = {
  success: { icon: '✓', cls: 'bg-matcha/35 text-cocoa' },
  error: { icon: '⚠', cls: 'bg-rosy/25 text-cocoa' },
  warning: { icon: '!', cls: 'bg-butter/60 text-cocoa' },
  loading: { icon: '⏳', cls: 'bg-cream text-cocoa' },
}

function ToastItem({ item }) {
  const s = STYLE[item.type] || STYLE.success
  return (
    <div
      data-toast-item
      data-type={item.type}
      className={`pointer-events-auto flex w-full max-w-md animate-floatIn items-start gap-2 rounded-2xl px-4 py-3 text-left shadow-card ${s.cls}`}
    >
      <span className="mt-px shrink-0 text-sm font-bold">{s.icon}</span>
      {/* 文案里可能带换行（多行错误说明），pre-line 保留排版 */}
      <span className="flex-1 whitespace-pre-line text-xs font-bold leading-relaxed">{item.text}</span>
      <button
        type="button"
        aria-label="关闭提示"
        onClick={() => toast.dismiss(item.id)}
        className="-mr-1 -mt-1 shrink-0 rounded-full px-1.5 py-0.5 text-xs font-bold text-cocoaSoft/70 transition active:scale-95"
      >
        ✕
      </button>
    </div>
  )
}

export function ToastViewport({ fallback = false } = {}) {
  const [list, setList] = useState(items)
  useEffect(() => subscribeToast(() => setList([...items]), fallback), [fallback])
  if (!list.length) return null
  // 位置说明：顶部被 Notifier 横幅 / 戳一戳卡片占用（pt-6、pt-8），这里走底部悬浮；
  // pb-24 避开 sticky 的底部导航条，多条提示向上堆叠
  return (
    <div
      data-toast-root
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[80] flex flex-col items-center gap-2 px-4 pb-24"
    >
      {list.map((it) => (
        <ToastItem key={it.id} item={it} />
      ))}
    </div>
  )
}

/** 显式挂载点：App 里挂一次即可；children 照常渲染，不受影响 */
export function ToastProvider({ children }) {
  return (
    <>
      {children}
      <ToastViewport />
    </>
  )
}

// ---------- 兜底自动挂载 ----------
// 没有 Provider 时（单测直接渲染页面组件 / 某些入口没挂），惰性创建一个独立 root，
// 保证提示仍然显示——「失败却什么都不弹」是最糟的体验。
let fallbackRoot = null

function teardownFallback() {
  if (!fallbackRoot) return
  const root = fallbackRoot
  fallbackRoot = null
  try {
    root.unmount()
  } catch {
    /* 兜底 root 卸载失败不影响主流程 */
  }
  const el = document.querySelector('[data-toast-fallback]')
  if (el && el.parentNode) el.parentNode.removeChild(el)
}

function ensureViewport() {
  // 已有 Provider 接管：兜底 root 必须撤掉，否则同一条提示会渲染两份
  if (hasProvider()) {
    teardownFallback()
    return
  }
  if (fallbackRoot || typeof document === 'undefined') return // 已兜底 / SSR 无 DOM
  const el = document.createElement('div')
  el.setAttribute('data-toast-fallback', '')
  document.body.appendChild(el)
  fallbackRoot = createRoot(el)
  fallbackRoot.render(<ToastViewport fallback />)
}
