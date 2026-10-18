// 矛盾处理室 · 房间内：消息流 + 发言权 + 倒计时 + 结束流程
//
// 布局做成熟悉的聊天页，但只有文字输入、且输入框只在轮到自己时可用。
// 刻意不显示回合数、进度条或快捷回复——那些会把「说话」变成「完成任务」。
import { useEffect, useRef } from 'react'
import { Button, TextArea } from '../../components/ui.jsx'
import { usePeaceRoom } from './usePeaceRoom.js'
import {
  FEEDBACK_OPTIONS,
  FEEDBACK_LABEL,
  HISTORY_TIP,
  STATUS_LABEL,
  formatClock,
  formatDuration,
} from './constants.js'

function Bubble({ msg, mine, name }) {
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] ${mine ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
        <span className="px-1 text-xs text-cocoaSoft">{mine ? '我' : name}</span>
        <div
          className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-[15px] leading-relaxed shadow-soft ${
            mine ? 'bg-blush text-white rounded-br-md' : 'bg-white text-cocoa rounded-bl-md'
          }`}
        >
          {msg.body}
        </div>
      </div>
    </div>
  )
}

export default function PeaceRoom({ room, coupleId, user, active = true, partnerName = 'TA', onBack }) {
  const {
    messages,
    loading,
    text,
    setText,
    send,
    sending,
    myTurn,
    isMine,
    ended,
    remainMs,
    myFeedback,
    partnerFeedback,
    requestEnd,
    respondEnd,
    setFeedback,
  } = usePeaceRoom({ room, coupleId, user, active })

  const bottomRef = useRef(null)
  useEffect(() => {
    // jsdom 没有 scrollIntoView：写成可选调用，测试里不至于整页渲染失败
    bottomRef.current?.scrollIntoView?.({ block: 'end' })
  }, [messages.length])

  if (!room) return null
  const isActive = room.status === 'active'
  const isInvited = room.status === 'invited'
  const iAmInviter = room.created_by === user?.id
  const endAskedByMe = room.end_requested_by === user?.id
  const endAskedByPartner = !!room.end_requested_by && !endAskedByMe

  return (
    <div className="flex h-[calc(100vh-7.5rem)] flex-col">
      {/* ---------- 顶部：状态 + 剩余时间 + 返回 ---------- */}
      <div className="flex items-center justify-between gap-3 border-b border-blush/20 pb-3">
        <button
          onClick={onBack}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-cocoaSoft shadow-soft"
          aria-label="返回"
        >
          ‹
        </button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate font-display text-lg text-cocoa">{STATUS_LABEL[room.status]}</p>
          <p className="text-xs text-cocoaSoft">
            {isActive ? (
              <>还剩 {formatClock(remainMs / 1000)}</>
            ) : (
              <>约定时长 {formatDuration(room.duration_seconds)}</>
            )}
          </p>
        </div>
        <div className="w-9 shrink-0" />
      </div>

      {/* ---------- 邀请待处理 ---------- */}
      {isInvited && (
        <div className="rounded-2xl bg-white p-4 shadow-card">
          <p className="text-sm leading-relaxed text-cocoa">
            {iAmInviter ? (
              <>邀请已发给 {partnerName}，等 TA 加入后开始计时。</>
            ) : (
              <>{partnerName} 想和你聊聊{room.invite_note ? `：${room.invite_note}` : ''}。</>
            )}
          </p>
          {room.invite_note && iAmInviter && (
            <p className="mt-2 rounded-xl bg-peach/40 px-3 py-2 text-sm text-cocoa">「{room.invite_note}」</p>
          )}
          <p className="mt-2 text-xs text-cocoaSoft">
            约定时长 {formatDuration(room.duration_seconds)} · 对方不加入也不会被催促
          </p>
        </div>
      )}

      {/* ---------- 消息流 ---------- */}
      <div className="mt-3 flex-1 space-y-3 overflow-y-auto scroll-none pb-2">
        {loading && messages.length === 0 ? (
          <p className="pt-10 text-center text-sm text-cocoaSoft">正在打开房间…</p>
        ) : messages.length === 0 ? (
          <p className="pt-10 text-center text-sm leading-relaxed text-cocoaSoft">
            {isActive ? (
              <>
                还没有人发言。
                <br />
                {myTurn ? '先说说你的想法吧。' : `等 ${partnerName} 先说。`}
              </>
            ) : (
              '本次沟通没有留下消息。'
            )}
          </p>
        ) : (
          messages.map((m) => <Bubble key={m.id} msg={m} mine={isMine(m.sender_user_id)} name={partnerName} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* ---------- 结束申请待确认 ---------- */}
      {isActive && endAskedByPartner && (
        <div className="rounded-2xl bg-peach/50 p-3 text-sm text-cocoa">
          <p className="mb-2">{partnerName} 申请提前结束本次沟通。</p>
          <div className="flex gap-2">
            <Button variant="primary" className="flex-1 py-2 text-sm" onClick={() => respondEnd(true)}>
              同意结束
            </Button>
            <Button variant="ghost" className="flex-1 py-2 text-sm" onClick={() => respondEnd(false)}>
              还想继续聊
            </Button>
          </div>
        </div>
      )}
      {isActive && endAskedByMe && (
        <p className="rounded-2xl bg-peach/40 px-3 py-2 text-center text-sm text-cocoaSoft">
          已发出结束申请，等 {partnerName} 确认（TA 不回应就继续聊）
        </p>
      )}

      {/* ---------- 底部输入 ---------- */}
      {isActive && (
        <div className="mt-2 border-t border-blush/20 pt-3">
          <TextArea
            rows={3}
            value={text}
            disabled={!myTurn || sending}
            placeholder={myTurn ? '慢慢说想法，不要伤害对方的痛处。' : '没关系，给对方一点时间组织语言。'}
            onChange={(e) => setText(e.target.value)}
            className="w-full"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button variant="primary" className="flex-1" disabled={!myTurn || sending} onClick={send}>
              {sending ? '发送中…' : myTurn ? '发送' : '等 TA 说完'}
            </Button>
            <Button variant="ghost" onClick={requestEnd}>
              提前结束
            </Button>
          </div>
        </div>
      )}

      {/* ---------- 已结束：记录保留 + 各自标记状态 ---------- */}
      {ended && (
        <div className="mt-2 border-t border-blush/20 pt-3">
          <p className="text-sm leading-relaxed text-cocoaSoft">
            {room.status === 'timed_out' ? HISTORY_TIP : '本次沟通已结束，记录已保存。'}
          </p>
          <p className="mt-3 mb-2 text-sm font-bold text-cocoa">这次沟通，你的感受是？</p>
          <div className="grid grid-cols-2 gap-2">
            {FEEDBACK_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => setFeedback(o.value)}
                className={`rounded-2xl border-2 px-3 py-2 text-sm font-bold transition ${
                  myFeedback?.status === o.value
                    ? 'border-blush bg-blush/10 text-rosy'
                    : 'border-blush/30 bg-white text-cocoa'
                }`}
              >
                <span className="mr-1">{o.emoji}</span>
                {o.label}
              </button>
            ))}
          </div>
          {partnerFeedback && (
            <p className="mt-2 text-xs text-cocoaSoft">
              {partnerName}：{FEEDBACK_LABEL[partnerFeedback.status]}
            </p>
          )}
          <p className="mt-1 text-xs text-cocoaSoft">标记只代表你现在的感受，不需要和 TA 一致。</p>
        </div>
      )}
    </div>
  )
}
