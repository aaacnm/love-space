import { useState } from 'react'

/**
 * 弱网自适应图片：
 * - 加载失败自动降级重试（缩图 → 原图 → 原图+防缓存参数），共 3 次
 * - 全部失败显示可点击重试的占位块（不再出现浏览器的「?」破图图标）
 * - 小图默认 lazy + async 解码，大图（预览）传 eager
 */
export default function SmartImg({ src, alt = '', className = '', style, eager = false, placeholder = '🥀' }) {
  const [attempt, setAttempt] = useState(0) // 0=原始 src（一般是 CDN 缩图）1=原图 2=原图+防缓存
  const [failed, setFailed] = useState(false)

  // 私有桶签名期间（src 为空）先不渲染，避免空 src 触发 onError 被误判成加载失败
  if (!src) return null

  if (failed) {
    return (
      <div
        role="button"
        tabIndex={0}
        title="加载失败，点击重试"
        onClick={() => {
          setFailed(false)
          setAttempt(0)
        }}
        className={`flex items-center justify-center bg-cream/80 text-2xl select-none ${className}`}
        style={style}
      >
        {placeholder}
      </div>
    )
  }

  let realSrc = src
  if (attempt === 1 && src.includes('?')) realSrc = src.split('?')[0] // 变换端点可能偶发失败，退回原图
  if (attempt === 2) realSrc = src.split('?')[0] + `?r=${Date.now()}` // 防缓存参数

  return (
    <img
      src={realSrc}
      alt={alt}
      className={className}
      style={style}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onError={() => {
        if (attempt < 2) setAttempt(attempt + 1)
        else setFailed(true)
      }}
    />
  )
}
