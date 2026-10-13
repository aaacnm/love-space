import { useEffect, useRef } from 'react'

// 列表底部「加载更多」：IntersectionObserver 接近底部 400px 时自动触发，
// 按钮兜底（jsdom / 老浏览器没有 IO，或用户想手动点）。
// hasMore=false 显示收尾文案；loading 期间按钮禁用、自动触发被 ref 拦住。
export default function LoadMore({ hasMore, loading, onLoadMore, empty }) {
  const sentinelRef = useRef(null)
  const stateRef = useRef({ hasMore, loading })
  stateRef.current = { hasMore, loading }

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((e) => e.isIntersecting) &&
          stateRef.current.hasMore &&
          !stateRef.current.loading
        ) {
          onLoadMore()
        }
      },
      { rootMargin: '400px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [onLoadMore])

  // 列表为空（空相册 / 空日记本）不渲染，避免空态下面再挂一句「到底啦」
  if (empty) return null
  if (!hasMore) {
    return <p className="py-5 text-center text-xs text-cocoaSoft/50">— 到底啦，都是你们的回忆 💗 —</p>
  }
  return (
    <div ref={sentinelRef} className="py-4 text-center">
      <button
        type="button"
        onClick={onLoadMore}
        disabled={loading}
        className="rounded-full bg-white/80 px-5 py-2 text-xs font-bold text-cocoa shadow-card ring-1 ring-blush/50 disabled:opacity-50"
      >
        {loading ? '加载中…' : '加载更多'}
      </button>
    </div>
  )
}
