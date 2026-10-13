import { useUnread } from '../lib/unread.jsx'

const TABS = [
  { key: 'home', label: '首页', emoji: '💕' },
  { key: 'diary', label: '日记', emoji: '📔' },
  { key: 'photos', label: '照片', emoji: '🖼️' },
  { key: 'peace', label: '和好', emoji: '🕊️' },
  { key: 'messages', label: '留言', emoji: '💌' },
  { key: 'period', label: '生理期', emoji: '🌸' },
]

export default function TabBar({ active, onChange }) {
  // 未读小红点来自统一未读中心；Provider 不在时 useUnread 安全降级为全零
  const { tabDots } = useUnread()
  return (
    // sticky 而不是 fixed：部分内嵌 WebView（预览面板/套壳浏览器）里 fixed 的
    // 定位基准不是可视区，导航条会被钉在文档中间；sticky 跟随真实滚动容器，
    // 普通浏览器里表现和 fixed 一致（滚动时一直贴底，滚到底停在文档末尾）
    <nav className="sticky bottom-0 z-40">
      <div className="mx-auto max-w-md border-t border-peach/40 bg-white/90 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="flex justify-between">
          {TABS.map((t) => {
            const on = active === t.key
            const dot = t.key === 'messages' ? tabDots.messages : t.key === 'diary' ? tabDots.diary : false
            const pulse = t.key === 'messages' && tabDots.messagesPulse
            return (
              <button
                key={t.key}
                onClick={() => onChange(t.key)}
                className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-bold transition ${
                  on ? 'text-rosy' : 'text-cocoaSoft/70'
                }`}
              >
                <span className={`relative text-xl transition ${on ? 'scale-110' : ''}`}>
                  {t.emoji}
                  {dot && (
                    <i className="absolute -right-1.5 -top-0.5 flex h-2.5 w-2.5">
                      {pulse && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />}
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white" />
                    </i>
                  )}
                </span>
                {t.label}
              </button>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
