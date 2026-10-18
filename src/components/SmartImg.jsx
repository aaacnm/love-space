import { useEffect, useState } from 'react'

/**
 * 弱网自适应图片：
 * - src 还没准备好（私有桶签名未返回）时**绝不渲染 <img>**：空 src 会让浏览器把当前页面
 *   地址当图片再请求一次，白白多一个请求还会让页面闪一下。此时渲染骨架占位（或什么都不渲染）。
 * - 加载失败自动降级重试（缩图 → 原图 → 原图+防缓存参数），共 3 次
 * - 全部失败显示可点击重试的占位块（不再出现浏览器的「?」破图图标）
 * - 小图默认 lazy + async 解码；首屏第一张传 priority（eager + fetchpriority=high）
 * - srcSet / sizes 由灯箱这类「一张图要按屏幕挑尺寸」的场景传入
 */
export default function SmartImg({
  src,
  alt = '',
  className = '',
  style,
  eager = false,
  // 首屏第一张：给浏览器「这张最要先拿到」的信号（fetchpriority=high + eager）。
  // 只给一张 —— 全标 high 等于全没标，浏览器还是自己猜
  priority = false,
  srcSet = '',
  sizes = '',
  placeholder = '🥀',
  skeleton = false,
  skeletonClass = '',
  onClick,
}) {
  const [attempt, setAttempt] = useState(0) // 0=原始 src（一般是 CDN 缩图）1=原图 2=原图+防缓存
  const [failed, setFailed] = useState(false)

  // 换了一张图（重新签名、切大图）：重试进度要归零，否则新地址会沿用上一次的失败状态
  useEffect(() => {
    setAttempt(0)
    setFailed(false)
  }, [src])

  // 签名期间 src 为空：只出骨架，不出 <img>
  if (!src) {
    if (!skeleton) return null
    return (
      <div
        aria-hidden="true"
        data-skeleton="true"
        className={`animate-pulse bg-cream/70 ${skeletonClass || className}`}
        style={style}
      />
    )
  }

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

  // 重试只加防缓存参数，**签名 token 与变换参数一律保留**：
  // 旧逻辑「去掉 query 退回原图」在私有桶上是双重错误——
  // ① 签名 token 就在 query 里，去掉必然 403；② 对缩略图来说等于退回原图，一次重试吃掉几 MB。
  // 原图只允许在灯箱/下载/导出这类明确操作里加载，重试绝不越界。
  const realSrc = attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}_r=${Date.now()}`

  return (
    <img
      src={realSrc}
      alt={alt}
      className={className}
      style={style}
      loading={priority || eager ? 'eager' : 'lazy'}
      // React 18 还不认 fetchpriority 这个属性名（会落到 fetchPriority），
      // 用属性展开的方式写，DOM 上留的就是标准的小写名
      {...(priority ? { fetchpriority: 'high' } : null)}
      {...(srcSet ? { srcSet } : null)}
      {...(sizes ? { sizes } : null)}
      decoding="async"
      onClick={onClick}
      onError={() => {
        if (attempt < 2) setAttempt(attempt + 1)
        else setFailed(true)
      }}
    />
  )
}
