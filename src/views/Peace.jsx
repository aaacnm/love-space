// 和好 tab · 矛盾处理室入口
//
// 这是一个「有秩序的说话地方」，不是裁判台：
//   · 一次只开一个房间，双方轮流、一人一条；
//   · 时间由发起者设定，从双方都加入才开始算；
//   · 提前结束必须双方都点头，且结束不等于和好。
// 房间内的一切规则由服务端（037 的 RPC）判定，这里只负责把状态画出来。
import { useContext, useEffect, useMemo, useState } from 'react'
import { useStore } from '../lib/store.jsx'
import { TabActiveContext, formatDateTime } from '../lib/hooks.js'
import { Button, EmptyState, Field, Modal, SectionTitle, Spinner, TextArea, TextInput } from '../components/ui.jsx'
import PeaceRoom from './peace/PeaceRoom.jsx'
import PeaceInviteActions from './peace/PeaceInviteActions.jsx'
import { usePeaceRooms } from './peace/usePeaceRooms.js'
import { DURATION_OPTIONS, STATUS_LABEL, formatDuration } from './peace/constants.js'

const LIVE = ['invited', 'active']

export default function Peace() {
  const { coupleId, user, partner } = useStore()
  const active = useContext(TabActiveContext)
  const { rooms, loading, busy, createRoom, joinRoom, cancelRoom, closeExpired } = usePeaceRooms({
    coupleId,
    enabled: active,
  })
  const [openId, setOpenId] = useState(null)
  const [creating, setCreating] = useState(false)
  const [seconds, setSeconds] = useState(DURATION_OPTIONS[1].seconds)
  const [note, setNote] = useState('')

  const partnerName = partner?.nickname || 'TA'

  // 回到页面 / 切回这个 tab：先把离线期间已经到期的房间落定
  useEffect(() => {
    if (!active || !coupleId) return
    closeExpired()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, coupleId])

  const live = useMemo(() => rooms.filter((r) => LIVE.includes(r.status)), [rooms])
  const history = useMemo(
    () =>
      rooms
        .filter((r) => !LIVE.includes(r.status))
        .slice()
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    [rooms],
  )
  const openRoom = openId ? rooms.find((r) => r.id === openId) || null : null

  // 房间已经不在列表里（被删 / 换了空间）就退回入口
  useEffect(() => {
    if (openId && !rooms.some((r) => r.id === openId)) setOpenId(null)
  }, [rooms, openId])

  if (openRoom) {
    return (
      <PeaceRoom
        room={openRoom}
        coupleId={coupleId}
        user={user}
        active={active}
        partnerName={partnerName}
        onBack={() => setOpenId(null)}
      />
    )
  }

  const submitCreate = async () => {
    const { error } = await createRoom(seconds, note)
    if (!error) {
      setCreating(false)
      setNote('')
    }
  }

  return (
    <div className="pb-6">
      <div className="rounded-3xl bg-white p-5 shadow-card">
        <p className="font-display text-xl text-cocoa">矛盾处理室</p>
        <p className="mt-2 text-sm leading-relaxed text-cocoaSoft">
          一个有发言秩序、有时间边界的说话地方：一人一条、轮流说完，时间到了就先停一下。
          <br />
          这里不判断谁对谁错，也不催你们和好。
        </p>
      </div>

      <div className="mt-5">
        <SectionTitle
          right={
            <Button onClick={() => setCreating(true)} disabled={busy || live.length > 0}>
              发起沟通
            </Button>
          }
        >
          现在
        </SectionTitle>
        {loading && live.length === 0 ? (
          <div className="py-6">
            <Spinner label="正在看有没有进行中的房间…" />
          </div>
        ) : live.length === 0 ? (
          <div className="rounded-2xl bg-cream p-4 text-center text-sm text-cocoaSoft">
            现在没有进行中的沟通。
            <br />
            想聊聊的时候再发起就好。
          </div>
        ) : (
          <div className="space-y-3">
            {live.map((r) => (
              <div key={r.id} className="rounded-2xl bg-white p-4 shadow-card">
                <div className="flex items-center justify-between">
                  <p className="font-bold text-cocoa">{STATUS_LABEL[r.status]}</p>
                  <span className="text-xs text-cocoaSoft">{formatDuration(r.duration_seconds)}</span>
                </div>
                {r.invite_note && (
                  <p className="mt-2 rounded-xl bg-peach/40 px-3 py-2 text-sm text-cocoa">「{r.invite_note}」</p>
                )}
                <div className="mt-3 flex gap-2">
                  <Button variant="soft" className="flex-1 py-2 text-sm" onClick={() => setOpenId(r.id)}>
                    进入房间
                  </Button>
                  {r.status === 'invited' && (
                    <PeaceInviteActions room={r} userId={user?.id} busy={busy} onJoin={joinRoom} onCancel={cancelRoom} />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-6">
        <SectionTitle>以前的记录</SectionTitle>
        {history.length === 0 ? (
          <EmptyState emoji="🕊️" text="还没有沟通记录" />
        ) : (
          <div className="space-y-2">
            {history.map((r) => (
              <button
                key={r.id}
                onClick={() => setOpenId(r.id)}
                className="flex w-full items-center justify-between rounded-2xl bg-white px-4 py-3 text-left shadow-soft"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-cocoa">{STATUS_LABEL[r.status]}</span>
                  <span className="block text-xs text-cocoaSoft">{formatDateTime(r.ended_at || r.created_at)}</span>
                </span>
                <span className="ml-2 shrink-0 text-xs text-cocoaSoft">{formatDuration(r.duration_seconds)} ›</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="发起一次沟通">
        <Field label="沟通时长">
          <div className="flex gap-2">
            {DURATION_OPTIONS.map((o) => (
              <button
                key={o.seconds}
                onClick={() => setSeconds(o.seconds)}
                className={`flex-1 rounded-2xl border-2 px-2 py-2 text-sm font-bold transition ${
                  seconds === o.seconds ? 'border-blush bg-blush/10 text-rosy' : 'border-blush/30 bg-white text-cocoa'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="自定义分钟数（5–120）">
          <TextInput
            type="number"
            min={5}
            max={120}
            value={Math.round(seconds / 60)}
            onChange={(e) => {
              const m = Number(e.target.value || 0)
              if (m >= 5 && m <= 120) setSeconds(m * 60)
            }}
          />
        </Field>
        <Field label="邀请说明（可选）">
          <TextArea
            rows={2}
            value={note}
            maxLength={60}
            placeholder="例如：我想和你聊聊刚才发生的事"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <p className="mb-3 text-xs leading-relaxed text-cocoaSoft">邀请发出后 24 小时内未处理会自动结束，不会反复催 TA。</p>
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={() => setCreating(false)}>
            再想想
          </Button>
          <Button className="flex-1" disabled={busy} onClick={submitCreate}>
            {busy ? '发送中…' : '发出邀请'}
          </Button>
        </div>
      </Modal>
    </div>
  )
}
