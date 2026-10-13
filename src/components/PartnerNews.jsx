import { useUnread } from '../lib/unread.jsx'
import { useStore } from '../lib/store.jsx'
import { gotoTab } from '../lib/notify.js'
import { MOODS } from '../lib/hooks.js'
import { Card } from './ui.jsx'

const moodEmoji = (v) => MOODS.find((m) => m.value === v)?.emoji || '🙂'

// 首页「TA 的新动态」：把散在各页的未读聚合成一块，不用逐个页面检查。
// 没有新动态时整个卡片不渲染（首页布局零变化）。
export default function PartnerNews() {
  const { counts, markSeen } = useUnread()
  const { partner } = useStore()
  if (!partner) return null

  const name = partner.nickname || 'TA'
  const items = []

  // 高优先级：想聊聊置顶
  if (counts.chat) {
    items.push({
      key: 'chat',
      icon: '💬',
      text: `${name} 想和你聊聊！`,
      hint: '点这里去说话',
      urgent: true,
      onClick: () => {
        markSeen('pokes')
        gotoTab('messages')
      },
    })
  }
  if (counts.messages > 0) {
    items.push({
      key: 'messages',
      icon: '💌',
      text: counts.messages > 99 ? '有 99+ 条新留言' : `有 ${counts.messages} 条新留言（含语音和回复）`,
      hint: '去看看',
      onClick: () => gotoTab('messages'),
    })
  }
  if (counts.diary > 0) {
    items.push({
      key: 'diary',
      icon: '📔',
      text: counts.diary > 99 ? '日记有 99+ 条新评论' : `日记有 ${counts.diary} 条新评论`,
      hint: '去看看',
      onClick: () => gotoTab('diary'),
    })
  }
  if (counts.pokes > 0) {
    items.push({
      key: 'pokes',
      icon: '💗',
      text: counts.pokes > 99 ? `${name} 戳了你 99+ 次` : `${name} 戳了戳你（${counts.pokes} 次）`,
      hint: '知道啦',
      onClick: () => markSeen('pokes'),
    })
  }
  if (counts.mood) {
    items.push({
      key: 'mood',
      icon: moodEmoji(counts.mood.mood),
      text: `${name} 的心情：${moodEmoji(counts.mood.mood)} ${counts.mood.mood}`,
      hint: '知道啦',
      onClick: () => markSeen('mood'),
    })
  }

  if (items.length === 0) return null

  return (
    <Card className="animate-pop !p-4 ring-2 ring-rosy/25">
      <p className="mb-2 flex items-center gap-1.5 text-sm font-bold text-cocoa">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rosy opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-rosy" />
        </span>
        TA 的新动态
      </p>
      <div className="space-y-1.5">
        {items.map((it) => (
          <button
            key={it.key}
            onClick={it.onClick}
            className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition active:scale-[0.98] ${
              it.urgent ? 'bg-blush/20' : 'bg-cream/70'
            }`}
          >
            <span className="text-lg leading-none">{it.icon}</span>
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-sm font-bold ${it.urgent ? 'text-rosy' : 'text-cocoa'}`}>{it.text}</span>
            </span>
            <span className="shrink-0 text-xs font-bold text-cocoaSoft/70">{it.hint} →</span>
          </button>
        ))}
      </div>
    </Card>
  )
}
