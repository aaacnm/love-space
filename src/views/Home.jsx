import { useEffect, useState } from 'react'
import { useStore } from '../lib/store.jsx'
import { supabase } from '../lib/supabase.js'
import { Card, Button, Modal, Field, TextInput } from '../components/ui.jsx'
import { Avatar } from '../components/Avatar.jsx'
import EditProfileModal from '../components/EditProfileModal.jsx'
import ManageMembersModal from '../components/ManageMembersModal.jsx'
import { PokeSection } from '../components/Poke.jsx'
import InteractiveGrid from '../components/InteractiveGrid.jsx'
import PartnerNews from '../components/PartnerNews.jsx'
import { Bone } from '../components/Skeleton.jsx'
import { timeInZone } from '../lib/hooks.js'

function useNow(interval = 1000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), interval)
    return () => clearInterval(t)
  }, [interval])
  return now
}

function diffParts(from, to) {
  let diff = Math.max(0, to - from)
  const days = Math.floor(diff / 86400000)
  diff -= days * 86400000
  const hours = Math.floor(diff / 3600000)
  diff -= hours * 3600000
  const mins = Math.floor(diff / 60000)
  diff -= mins * 60000
  const secs = Math.floor(diff / 1000)
  return { days, hours, mins, secs }
}

const pad = (n) => String(n).padStart(2, '0')

// 'YYYY-MM-DD' 是纯日期，直接 new Date() 会按 UTC 零点解析（东八区等于早上 8 点），
// 算出来的天数会少 8 小时。这里统一按本地零点解析。
function parseDay(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

const startOfToday = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

// 日历天差：今天 = 0，明天 = 1（不受时区/时分秒影响）
const daysFromToday = (s) => Math.round((parseDay(s) - startOfToday()) / 86400000)

const cnDate = (s) => {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number)
  return `${y}年${m}月${d}日`
}

export default function Home() {
  const { couple, members, milestones, myMember, partner, refresh, derived, loading } = useStore()
  const now = useNow()
  const [showMeetup, setShowMeetup] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const [showAnniv, setShowAnniv] = useState(false)
  const [annivDate, setAnnivDate] = useState('')
  const [meetupTitle, setMeetupTitle] = useState('见面')
  const [meetupDate, setMeetupDate] = useState('')
  const [saving, setSaving] = useState(false)

  // 邀请文案按自己的性别角色化：男生邀请「她」，女生邀请「他」
  const inviteHint =
    myMember?.gender === 'male'
      ? '点一下复制，发给女朋友，邀请她加入这个空间'
      : myMember?.gender === 'female'
        ? '点一下复制，发给男朋友，邀请他加入这个空间'
        : '点一下复制，发给 TA 加入这个空间'

  // 纪念日 / 下次见面：优先用服务端在 bootstrap 里算好的（省一次排序），
  // RPC 不可用或缓存太旧时回退到本地计算；缓存里的「下次见面」可能是昨天的，要再校验一次日期
  const serverNext =
    derived?.nextMeetup && parseDay(derived.nextMeetup.date) >= startOfToday() ? derived.nextMeetup : null
  const anniversary = derived?.anniversary || milestones.find((m) => m.type === 'anniversary')
  const futureMeetups = milestones
    .filter((m) => m.type === 'meetup' && parseDay(m.date) >= startOfToday())
    .sort((a, b) => parseDay(a.date) - parseDay(b.date))
  const nextMeetup = serverNext || futureMeetups[0]

  const together = anniversary ? diffParts(parseDay(anniversary.date), now) : null

  let progress = 0
  if (anniversary && nextMeetup) {
    const start = parseDay(anniversary.date).getTime()
    const end = parseDay(nextMeetup.date).getTime()
    progress = Math.min(1, Math.max(0, (now - start) / (end - start)))
  }

  // 打开纪念日弹窗时带上当前值；没设置过就留空让用户填
  const openAnniv = () => {
    setAnnivDate(anniversary?.date ? String(anniversary.date).slice(0, 10) : '')
    setShowAnniv(true)
  }

  const saveAnniv = async () => {
    if (!annivDate) return
    setSaving(true)
    // 已有就改日期，没有就新建一条 anniversary 里程碑（双方都能改，改完实时同步）
    const { error } = await supabase.from('milestones').upsert(
      {
        id: anniversary?.id,
        couple_id: couple.id,
        type: 'anniversary',
        title: '在一起',
        date: annivDate,
      },
      { onConflict: 'id' },
    )
    setSaving(false)
    if (!error) {
      setShowAnniv(false)
      await refresh()
    }
  }

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(couple?.code || '')
    } catch {
      /* ignore */
    }
  }

  const saveMeetup = async () => {
    if (!meetupDate) return
    setSaving(true)
    // 更新最近的见面节点（存在则改日期，不存在则新建）
    const { error } = await supabase.from('milestones').upsert(
      {
        id: nextMeetup?.id,
        couple_id: couple.id,
        type: 'meetup',
        title: meetupTitle || '见面',
        date: meetupDate,
      },
      { onConflict: 'id' },
    )
    setSaving(false)
    if (!error) {
      setShowMeetup(false)
      await refresh()
    }
  }

  return (
    <div className="space-y-4">
      {/* TA 的新动态：未读聚合（想聊聊/新留言/日记评论/戳一戳/心情），没有新动态时不渲染 */}
      <PartnerNews />

      {/* 顶部：两人 + 情侣码 */}
      <Card className="text-center">
        <div className="flex items-center justify-center gap-3">
          <Avatar member={myMember} size="lg" />
          <h1 className="font-display text-2xl text-cocoa">
            {myMember?.nickname || '我'} <span className="text-blush">❤</span> {partner?.nickname || 'TA'}
          </h1>
          <Avatar member={partner} size="lg" />
        </div>
        <button
          onClick={copyCode}
          className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-blush/10 px-4 py-1.5 text-sm font-bold text-rosy"
        >
          情侣码 <span className="font-display tracking-[0.2em]">{couple?.code || '••••••'}</span> 📋
        </button>
        <p className="mt-1 text-xs text-cocoaSoft/70">{inviteHint}</p>
        <button
          onClick={() => setShowProfile(true)}
          className="mt-2 inline-flex items-center gap-1 rounded-full bg-cream px-4 py-1.5 text-sm font-bold text-cocoaSoft"
        >
          ✏️ 编辑我的资料
        </button>
      </Card>

      {/* 在一起天数 */}
      <Card className="text-center">
        <p className="text-sm font-bold text-cocoaSoft">我们已经在一起</p>
        {together ? (
          <>
            <div className="my-2 flex items-end justify-center gap-1">
              <span className="font-display text-6xl leading-none text-rosy">{together.days}</span>
              <span className="mb-1 text-xl font-bold text-cocoa">天</span>
            </div>
            <div className="font-display text-xl text-cocoaSoft">
              {pad(together.hours)} 时 {pad(together.mins)} 分 {pad(together.secs)} 秒
            </div>
            <p className="mt-1 text-xs text-cocoaSoft/70">自 {cnDate(anniversary.date)} 起</p>
          </>
        ) : (
          <p className="py-6 text-sm text-cocoaSoft">还没设置在一起的日子，点下面定一个吧 ❤</p>
        )}
        <Button variant="ghost" className="mt-3 w-full" onClick={openAnniv}>
          {anniversary ? '💞 修改纪念日' : '💞 设置纪念日'}
        </Button>
      </Card>

      {/* 下次见面倒计时 */}
      <Card className="text-center">
        <p className="text-sm font-bold text-cocoaSoft">距离下次见面还有</p>
        {nextMeetup ? (
          <>
            <div className="my-2 flex items-end justify-center gap-1">
              <span className="font-display text-6xl leading-none text-blush">
                {Math.max(0, daysFromToday(nextMeetup.date))}
              </span>
              <span className="mb-1 text-xl font-bold text-cocoa">天</span>
            </div>
            <p className="mb-3 text-sm text-cocoaSoft">
              {nextMeetup.title} · {nextMeetup.date}
            </p>
            <div className="h-3 w-full overflow-hidden rounded-full bg-peach/40">
              <div
                className="h-full rounded-full bg-gradient-to-r from-blush to-rosy transition-all duration-1000"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-cocoaSoft/70">见面倒计时进行中，越来越近啦 🎉</p>
          </>
        ) : (
          <p className="py-4 text-sm text-cocoaSoft">还没定下次见面的日子，定一个给自己打气吧</p>
        )}
        <Button variant="ghost" className="mt-3 w-full" onClick={() => setShowMeetup(true)}>
          {nextMeetup ? '📅 修改下次见面' : '📅 设置下次见面'}
        </Button>
      </Card>

      {/* 戳一戳（压缩为一行） */}
      <PokeSection compact />

      {/* 互动磁贴：心情 / 一问 / 转盘 / 距离，点开弹大窗 */}
      <InteractiveGrid />

      {/* 两人时区 */}
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-bold text-cocoaSoft">我们此刻的时间</p>
          <button onClick={() => setShowMembers(true)} className="text-xs font-bold text-rosy">
            管理成员
          </button>
        </div>
        <div className="space-y-3">
          {loading && members.length === 0 ? (
            // 首页永远先站结构：成员还没到就占一行同高度的骨架，避免空→有的位移
            <div aria-hidden="true" data-skeleton="true" className="flex items-center justify-between rounded-2xl bg-cream px-4 py-3">
              <div className="flex items-center gap-3">
                <Bone rounded="rounded-full" className="h-10 w-10" />
                <div className="space-y-2">
                  <Bone rounded="rounded-full" className="h-3 w-16" />
                  <Bone rounded="rounded-full" className="h-2.5 w-24" />
                </div>
              </div>
              <Bone className="h-6 w-12" />
            </div>
          ) : (
            members.map((m) => (
              <div key={m.id} className="flex items-center justify-between rounded-2xl bg-cream px-4 py-3">
                <div className="flex items-center gap-3">
                  <Avatar member={m} size="md" />
                  <div>
                    <div className="font-bold text-cocoa">{m.nickname}</div>
                    <div className="text-xs text-cocoaSoft">{m.city || '未填写城市'}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-display text-xl text-rosy">{m.timezone ? timeInZone(m.timezone) : '--:--'}</div>
                  <div className="text-xs text-cocoaSoft/70">
                    {m.timezone ? m.timezone.split('/').pop().replace('_', ' ') : ''}
                  </div>
                </div>
              </div>
            ))
          )}
          {!loading && members.length < 2 && (
            <p className="text-center text-sm text-cocoaSoft">把情侣码发给 TA，这里会显示 TA 的时间 💌</p>
          )}
        </div>
      </Card>

      {/* 设置 / 修改纪念日弹窗 */}
      <Modal open={showAnniv} onClose={() => setShowAnniv(false)} title="在一起的纪念日">
        <div className="space-y-4">
          <Field label="我们在一起的那天">
            <TextInput type="date" value={annivDate} onChange={(e) => setAnnivDate(e.target.value)} />
          </Field>
          <p className="text-xs text-cocoaSoft/70">
            改完首页的天数会立刻重新算，TA 那边也会同步（这个是你们共用的，谁改都一样）。
          </p>
          <Button className="w-full" onClick={saveAnniv} disabled={saving || !annivDate}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </Modal>

      {/* 设置见面弹窗 */}
      <Modal open={showMeetup} onClose={() => setShowMeetup(false)} title="设置下次见面">
        <div className="space-y-4">
          <Field label="见面标签">
            <TextInput value={meetupTitle} onChange={(e) => setMeetupTitle(e.target.value)} placeholder="见面 / 一起去旅行…" />
          </Field>
          <Field label="见面日期">
            <TextInput type="date" value={meetupDate} onChange={(e) => setMeetupDate(e.target.value)} />
          </Field>
          <Button className="w-full" onClick={saveMeetup} disabled={saving || !meetupDate}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </Modal>

      {/* 编辑资料弹窗 */}
      <EditProfileModal open={showProfile} onClose={() => setShowProfile(false)} />

      {/* 管理成员弹窗 */}
      <ManageMembersModal open={showMembers} onClose={() => setShowMembers(false)} />
    </div>
  )
}
