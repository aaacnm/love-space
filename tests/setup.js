/**
 * Vitest 全局准备：DOM 扩展断言 + 每个用例后自动卸载 React 树 + 浏览器 API 兜底。
 * jsdom 没实现的浏览器 API 在这里补齐，业务代码可以像在真浏览器里一样跑。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// 绝大多数用例跑在 jsdom 里，但也有纯逻辑用例显式声明 `@vitest-environment node`
// （例如 Service Worker 的策略测试，只需要 fetch/Response 这些 Node 自带的原语）。
// 用 hasDom 把 DOM 相关的准备隔开，两种环境都能复用同一份 setup。
const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined'

// 每个用例后卸载组件树并清空 DOM：避免上一个用例的订阅/定时器泄漏到下一个
afterEach(() => {
  if (!hasDom) return
  cleanup()
  document.body.innerHTML = ''
  // 列表缓存（lib/collectionCache.js）与签名 URL 缓存（lib/storage.js）都写在
  // localStorage 里，同文件内会串到下一个用例。这里统一清干净：
  // 想验证「有缓存」的用例自己在用例里写。
  try {
    const doomed = []
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i)
      if (k && (k.startsWith('love.list.v1:') || k === 'love.sign.v1')) doomed.push(k)
    }
    doomed.forEach((k) => window.localStorage.removeItem(k))
  } catch {
    /* noop */
  }
})

// ---------- jsdom 缺失的浏览器 API ----------

if (hasDom && !window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}

// 「首屏画完再说」的空闲回调：jsdom 没有 requestIdleCallback，
// 这里用「下一轮宏任务」兜底，让延迟到空闲的请求（未读统计、分包预热）在测试里
// 也能很快兑现，而不是干等 400ms 的降级定时器。
if (hasDom && !window.requestIdleCallback) {
  window.requestIdleCallback = (cb) =>
    setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0)
  window.cancelIdleCallback = (id) => clearTimeout(id)
}

// 加载更多（IntersectionObserver）/ 尺寸监听（ResizeObserver）
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
if (hasDom && !window.IntersectionObserver) window.IntersectionObserver = NoopObserver
if (hasDom && !window.ResizeObserver) window.ResizeObserver = NoopObserver

// 图片 blob URL：上传预览与 iOS 批量保存会用到
if (hasDom && !URL.createObjectURL) {
  let n = 0
  URL.createObjectURL = () => `blob:mock/${++n}`
  URL.revokeObjectURL = () => {}
}

// jsdom 的 crypto 不一定带 randomUUID（上传路径依赖它）
if (!globalThis.crypto?.randomUUID) {
  let n = 0
  const rand = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  if (!globalThis.crypto) globalThis.crypto = {}
  if (!globalThis.crypto.randomUUID) {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: rand, configurable: true })
  }
}

// 录音/语音播放会碰 AudioContext：测试里默认不提供，业务代码已有降级分支
globalThis.__VITEST__ = true
vi.stubGlobal('__VITEST__', true)
