/**
 * Vitest 全局准备：DOM 扩展断言 + 每个用例后自动卸载 React 树 + 浏览器 API 兜底。
 * jsdom 没实现的浏览器 API 在这里补齐，业务代码可以像在真浏览器里一样跑。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// 每个用例后卸载组件树并清空 DOM：避免上一个用例的订阅/定时器泄漏到下一个
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

// ---------- jsdom 缺失的浏览器 API ----------

if (!window.matchMedia) {
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

// 加载更多（IntersectionObserver）/ 尺寸监听（ResizeObserver）
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
if (!window.IntersectionObserver) window.IntersectionObserver = NoopObserver
if (!window.ResizeObserver) window.ResizeObserver = NoopObserver

// 图片 blob URL：上传预览与 iOS 批量保存会用到
if (!URL.createObjectURL) {
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
