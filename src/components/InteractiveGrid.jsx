import { useMemo, useState } from 'react'
import { useStore } from '../lib/store.jsx'
import { useCollection, MOODS, todayStr } from '../lib/hooks.js'
import { lookupCity, distanceKm } from '../lib/cities.js'
import { Modal } from './ui.jsx'
import MoodCard from './MoodCard.jsx'
import DistanceCard from './DistanceCard.jsx'

const moodEmoji = (v) => MOODS.find((m) => m.value === v)?.emoji || '🙂'

function daysSince(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  const then = new Date(y, m - 1, d).getTime()
  const now = new Date().setHours(0, 0, 0, 0)
  return Math.max(0, Math.floor((now - then) / 86400000))
}

const TITLES = {
  mood: '今天的心情',
  distance: '我们之间',
}

// 首页的互动磁贴墙：四个功能各占一格，只显示一行状态，点开弹大窗操作
export default function InteractiveGrid() {
  const { coupleId, user, myMember, partner, milestones } = useStore()
  const [open, setOpen] = useState(null)

  const { rows: moods } = useCollection('moods', coupleId)

  const today = todayStr()

  const myMood = moods.find((r) => r.date === today && r.user_id === user?.id) || null
  const taMood = moods.find((r) => r.date === today && r.user_id !== user?.id) || null

  const me = useMemo(() => lookupCity(myMember?.city), [myMember?.city])
  const ta = useMemo(() => lookupCity(partner?.city), [partner?.city])
  const km = me && ta ? distanceKm(me, ta) : null

  const lastMeetup = useMemo(
    () =>
      milestones
        .filter((m) => m.type === 'meetup' && m.date < today)
        .sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null,
    [milestones, today],
  )
  const apartDays = lastMeetup ? daysSince(lastMeetup.date) : null

  const tiles = [
    {
      key: 'mood',
      icon: '🌈',
      title: '今日心情',
      value: myMood ? `${moodEmoji(myMood.mood)} ${myMood.mood}` : taMood ? `TA ${moodEmoji(taMood.mood)} ${taMood.mood}` : '还没记录',
      hint: myMood ? '点开改一下' : '点开记录今天',
      alert: !myMood,
    },
    {
      key: 'distance',
      icon: '🗺️',
      title: '我们之间',
      value: km ? `${km} km` : '待填城市',
      hint: apartDays !== null ? `已分开 ${apartDays} 天` : km ? '点开看地图' : '两人都要填城市',
      alert: false,
    },
  ]

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        {tiles.map((t) => (
          <button
            key={t.key}
            onClick={() => setOpen(t.key)}
            className={`rounded-card bg-white p-4 text-left shadow-card transition active:scale-95 ${
              t.alert ? 'ring-2 ring-blush/50' : ''
            }`}
          >
            <div className="flex items-center gap-1.5 text-xs font-bold text-cocoaSoft">
              <span className="text-base leading-none">{t.icon}</span>
              {t.title}
            </div>
            <div className={`mt-1.5 truncate font-display text-lg ${t.alert ? 'text-rosy' : 'text-cocoa'}`}>
              {t.value}
            </div>
            <div className="mt-0.5 truncate text-xs text-cocoaSoft/70">{t.hint}</div>
          </button>
        ))}
      </div>

      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? TITLES[open] : ''}>
        {open === 'mood' && <MoodCard bare />}
        {open === 'distance' && <DistanceCard bare />}
      </Modal>
    </>
  )
}
