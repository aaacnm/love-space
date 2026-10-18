// 骨架屏：页面结构先站住，数据到了再填。
//
// 用法要点（比「画得像」更重要）：
// - 骨架的**外框尺寸必须和真卡片一致**，否则数据到达那一刻会跳一下，白忙一场；
// - 一律 aria-hidden，屏幕阅读器不该读到一堆假内容；
// - 只在「确实还没有东西可画」时出现：本地缓存里有内容就直接画真内容。
import { Card } from './ui.jsx'

// 一根骨头。rounded 默认走卡片同款圆角积木感
export function Bone({ className = '', rounded = 'rounded-xl', style }) {
  return (
    <div
      aria-hidden="true"
      data-skeleton="true"
      style={style}
      className={`animate-pulse bg-cream/70 ${rounded} ${className}`}
    />
  )
}

// 多行文本占位：宽度递减模拟排版，最后一根短一些更像自然换行
export function Lines({ n = 2, className = '' }) {
  const widths = ['w-full', 'w-11/12', 'w-4/5', 'w-2/3', 'w-1/2']
  return (
    <div aria-hidden="true" data-skeleton="true" className={`space-y-2 ${className}`}>
      {Array.from({ length: n }).map((_, i) => (
        <Bone key={i} className={`h-3 ${widths[i % widths.length]}`} rounded="rounded-full" />
      ))}
    </div>
  )
}

// 日期筛选条（月份胶囊 + 日期选择 + 计数）
export function FilterBarSkeleton() {
  return (
    <div aria-hidden="true" data-skeleton="true" className="mb-3 space-y-2">
      <div className="flex gap-2 overflow-hidden">
        {[64, 72, 72].map((w, i) => (
          <Bone key={i} rounded="rounded-full" className="h-7 shrink-0" style={{ width: w }} />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Bone className="h-8 w-36" />
        <Bone className="ml-auto h-8 w-16" />
      </div>
    </div>
  )
}

// 留言流：便利贴外形（贴纸底 + 圆角 + 阴影），结构与 MessageCard 对齐
export function NoteListSkeleton({ count = 4 }) {
  return (
    <div aria-hidden="true" data-skeleton="true" className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border border-peach/40 bg-cream/50 p-3.5 shadow-soft">
          <div className="flex items-center gap-2">
            <Bone rounded="rounded-full" className="h-7 w-7" />
            <Bone rounded="rounded-full" className="h-3 w-20" />
            <Bone rounded="rounded-full" className="ml-auto h-3 w-12" />
          </div>
          <Lines n={i % 2 === 0 ? 2 : 1} className="mt-2.5" />
          {/* 隔一张放个图片位：真实流里照片留言挺常见的，位置先占住 */}
          {i % 2 === 0 && <Bone className="mt-2 aspect-[4/3] w-full" />}
          <div className="mt-2.5 flex gap-1">
            <Bone rounded="rounded-full" className="h-4 w-12" />
            <Bone rounded="rounded-full" className="h-4 w-10" />
          </div>
        </div>
      ))}
    </div>
  )
}

// 日记流：Card 外形（白色圆卡片 + p-5），结构与 Diary.renderCard 对齐
export function DiaryListSkeleton({ count = 3 }) {
  return (
    <div aria-hidden="true" data-skeleton="true" className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bone rounded="rounded-full" className="h-10 w-10" />
              <div className="space-y-2">
                <Bone rounded="rounded-full" className="h-3 w-20" />
                <Bone rounded="rounded-full" className="h-3 w-28" />
              </div>
            </div>
            <Bone rounded="rounded-full" className="h-6 w-16" />
          </div>
          <Lines n={i % 2 === 0 ? 3 : 2} className="mt-3" />
          {i % 2 === 0 && (
            <div className="mt-3 flex gap-2">
              <Bone className="h-16 w-16" />
              <Bone className="h-16 w-16" />
            </div>
          )}
          <Bone rounded="rounded-full" className="mt-3 h-3 w-24" />
        </Card>
      ))}
    </div>
  )
}

// 照片墙：网格用 aspect-square，和 PhotoGrid 的真瓦片完全一致（2 列）
export function PhotoGridSkeleton({ count = 6, cols = 2 }) {
  return (
    <div aria-hidden="true" data-skeleton="true" className={`grid gap-3 ${cols === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
      {Array.from({ length: count }).map((_, i) => (
        <Bone key={i} className="aspect-square w-full rounded-2xl" />
      ))}
    </div>
  )
}
