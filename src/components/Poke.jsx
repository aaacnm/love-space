import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store.jsx'
import { supabase } from '../lib/supabase.js'
import { toast } from '../lib/toast.jsx'
import { useCollection, useLatestRow, formatDateTime } from '../lib/hooks.js'
import { subscribeTable } from '../lib/realtimeBus.js'
import { gotoTab } from '../lib/notify.js'
import { Card, Modal } from './ui.jsx'

function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function buzz(ms = 30) {
  try {
    if (navigator.vibrate) navigator.vibrate(ms)
  } catch {
    /* 部分浏览器不支持，忽略 */
  }
}

// kind: 'poke' 戳一戳 / 'comfort' 摸摸头 / 'chat' 想聊聊（高优先级提醒）
export async function sendPoke(coupleId, userId, kind = 'poke') {
  if (!coupleId || !userId) return
  const { error } = await supabase
    .from('pokes')
    .insert({ couple_id: coupleId, from_user_id: userId, kind })
  if (error) toast.error('发送失败：' + error.message)
}

// ---------- 首页卡片：发送 + 统计 ----------

// compact = true 时压成一行横条（首页用），false 为完整大卡片
//
// 首页（compact）只查「最近一条戳」：今天/我/TA 各戳了多少次属于历史统计，
// 为它把整个空间几千条 poke 拉下来不值（首页首屏请求直接少一条大查询）。
// 想要统计就点「戳一戳记录」，弹窗里才挂载完整卡片 → 那时才拉全量。
export function PokeSection({ compact = false }) {
  const { coupleId, user, partner } = useStore()
  const { rows } = useCollection('pokes', coupleId, { enabled: !compact })
  const { row: latest } = useLatestRow('pokes', coupleId, { enabled: compact })
  const [sending, setSending] = useState(false)
  const [burst, setBurst] = useState(false)
  // 想聊聊按钮：sending → sent 两态，发完给一句确认再复原
  const [chatState, setChatState] = useState(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const chatTimer = useRef(null)

  const mineCount = rows.filter((r) => r.from_user_id === user?.id).length
  const partnerCount = rows.length - mineCount
  const todayCount = rows.filter((r) => new Date(r.created_at) >= startOfToday()).length
  const last = compact ? latest : rows[0]

  const handleSend = async () => {
    if (sending) return
    setSending(true)
    setBurst(true)
    buzz()
    await sendPoke(coupleId, user?.id)
    setTimeout(() => setBurst(false), 700)
    setSending(false)
  }

  const handleChat = async () => {
    if (chatState) return
    setChatState('sending')
    buzz()
    await sendPoke(coupleId, user?.id, 'chat')
    setChatState('sent')
    clearTimeout(chatTimer.current)
    chatTimer.current = setTimeout(() => setChatState(null), 2500)
  }

  useEffect(() => () => clearTimeout(chatTimer.current), [])

  if (compact) {
    return (
      <Card className="flex items-center gap-3 !p-4">
        <button
          onClick={handleSend}
          disabled={sending}
          className={`relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blush to-rosy text-2xl shadow-card transition active:scale-90 ${
            burst ? 'animate-pop' : ''
          }`}
        >
          💕
          {burst && (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="heart-up text-xl">💗</span>
            </span>
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="font-bold text-cocoa">想 TA 就戳一下</div>
          <div className="mt-0.5 truncate text-xs text-cocoaSoft">
            {last
              ? `最近一次：${formatDateTime(last.created_at)}（${last.from_user_id === user?.id ? '我' : partner?.nickname || 'TA'}）`
              : '还没有记录，戳第一下试试 ✨'}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button
              onClick={handleChat}
              disabled={chatState === 'sending'}
              className="rounded-full bg-cream px-3 py-1 text-xs font-bold text-rosy transition active:scale-95 disabled:opacity-60"
            >
              {chatState === 'sent' ? '已告诉 TA 啦 💬' : chatState === 'sending' ? '发送中…' : '💬 想和 TA 聊聊'}
            </button>
            <button
              onClick={() => setHistoryOpen(true)}
              className="rounded-full bg-cream px-3 py-1 text-xs font-bold text-cocoaSoft transition active:scale-95"
            >
              戳一戳记录 ›
            </button>
          </div>
        </div>
        {/* 历史统计放弹窗里：Modal 关着时不挂载，里面的 useCollection('pokes')
            也就不发请求——首页首屏不再为「今天/我/TA 各几次」拉全表 */}
        <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="戳一戳记录">
          <PokeSection />
        </Modal>
      </Card>
    )
  }

  return (
    <Card className="text-center">
      <p className="text-sm font-bold text-cocoaSoft">想 TA 的时候就戳一下</p>

      <button
        onClick={handleSend}
        disabled={sending}
        className={`relative mx-auto my-3 flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-blush to-rosy text-4xl shadow-card transition active:scale-90 disabled:opacity-50 ${
          burst ? 'animate-pop' : 'hover:scale-105'
        }`}
      >
        💕
        {burst && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="heart-up text-2xl">💗</span>
          </span>
        )}
      </button>

      <p className="text-sm font-bold text-cocoa">
        TA 的手机会立刻收到提醒 <span className="text-rosy">🥰</span>
      </p>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="rounded-2xl bg-cream px-2 py-3">
          <div className="font-display text-2xl leading-none text-rosy">{todayCount}</div>
          <div className="mt-1 text-xs text-cocoaSoft">今天</div>
        </div>
        <div className="rounded-2xl bg-cream px-2 py-3">
          <div className="font-display text-2xl leading-none text-rosy">{mineCount}</div>
          <div className="mt-1 text-xs text-cocoaSoft">我戳的</div>
        </div>
        <div className="rounded-2xl bg-cream px-2 py-3">
          <div className="font-display text-2xl leading-none text-blush">{partnerCount}</div>
          <div className="mt-1 text-xs text-cocoaSoft">TA 戳的</div>
        </div>
      </div>

      {last ? (
        <p className="mt-3 text-xs text-cocoaSoft/70">
          最近一次：{formatDateTime(last.created_at)}（{last.from_user_id === user?.id ? '我' : partner?.nickname || 'TA'}）
        </p>
      ) : (
        <p className="mt-3 text-xs text-cocoaSoft/70">还没有记录，戳第一下试试 ✨</p>
      )}
    </Card>
  )
}

// ---------- 全局监听：收到对方的戳时弹出提醒 ----------

export function PokeListener() {
  const { coupleId, user, myMember, partner } = useStore()
  const [toast, setToast] = useState(null)
  const timerRef = useRef(null)

  // 订阅挂在 space-<coupleId> 共享频道上（不再单独建 poke-listener 频道）。
  // 这里只处理「此刻收到的戳」，开机时不需要先查一条最新记录——
  // 历史戳的展示归 PokeSection，未读提醒归 UnreadProvider。
  useEffect(() => {
    if (!coupleId || !user) return

    const off = subscribeTable(coupleId, 'pokes', (payload) => {
      if (payload.eventType !== 'INSERT') return
      const row = payload.new
      if (!row || row.from_user_id === user.id) return
      buzz(60)
      setToast({ id: row.id, name: partner?.nickname || 'TA', kind: row.kind || 'poke' })
      // 普通戳/摸摸头的 toast 用户已经看到 → 广播未读中心把首页卡片条目清掉；
      // 「想聊聊」不广播：高优先级提醒要一直挂到用户真的去留言页
      if ((row.kind || 'poke') !== 'chat') {
        window.dispatchEvent(new CustomEvent('unread:seen', { detail: 'pokes' }))
      }
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setToast(null), 5000)
    })

    return () => {
      clearTimeout(timerRef.current)
      off()
    }
  }, [coupleId, user, myMember, partner])

  if (!toast) return null

  return (
    <div className="pointer-events-none fixed inset-0 z-[60] flex items-start justify-center px-4 pt-8">
      <div className="pointer-events-auto w-full max-w-md animate-floatIn rounded-card bg-white p-5 text-center shadow-card">
        {toast.kind === 'chat' ? (
          <>
            <div className="mb-1 text-4xl">💬</div>
            <p className="font-display text-xl text-cocoa">{toast.name} 想和你聊聊</p>
            <p className="mt-1 text-sm text-cocoaSoft">TA 现在想听你说说话</p>
          </>
        ) : toast.kind === 'comfort' ? (
          <>
            <div className="mb-1 text-4xl">🫂</div>
            <p className="font-display text-xl text-cocoa">{toast.name} 摸了摸你的头</p>
            <p className="mt-1 text-sm text-cocoaSoft">看到你今天不太轻松，抱抱你</p>
          </>
        ) : (
          <>
            <div className="mb-1 text-4xl">💗</div>
            <p className="font-display text-xl text-cocoa">{toast.name} 想你了！</p>
            <p className="mt-1 text-sm text-cocoaSoft">刚刚戳了你一下</p>
          </>
        )}
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => setToast(null)}
            className="flex-1 rounded-full bg-cream py-2.5 text-sm font-bold text-cocoaSoft"
          >
            知道啦
          </button>
          {toast.kind === 'chat' ? (
            <button
              onClick={() => {
                setToast(null)
                gotoTab('messages') // 进入留言页后，未读中心会自动清掉「想聊聊」提醒
              }}
              className="flex-1 rounded-full bg-rosy py-2.5 text-sm font-bold text-white shadow-card transition active:scale-95"
            >
              去聊聊 →
            </button>
          ) : (
            <button
              onClick={async () => {
                await sendPoke(coupleId, user?.id)
                buzz()
                setToast(null)
              }}
              className="flex-1 rounded-full bg-blush py-2.5 text-sm font-bold text-white shadow-card transition active:scale-95"
            >
              回戳一下 💕
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
