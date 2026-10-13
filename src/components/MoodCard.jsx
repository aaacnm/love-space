import { useState } from 'react'
import { useStore } from '../lib/store.jsx'
import { supabase } from '../lib/supabase.js'
import { useCollection, MOODS, todayStr } from '../lib/hooks.js'
import { Card, Button, TextInput } from './ui.jsx'
import { Avatar } from './Avatar.jsx'
import { sendPoke } from './Poke.jsx'

const NEED_COMFORT = ['难过', '疲惫', '想念', '生气']

function moodEmoji(name) {
  return MOODS.find((m) => m.value === name)?.emoji || '🙂'
}

// bare = true 时用在弹窗内部（不套外层 Card）
export default function MoodCard({ bare = false }) {
  const { coupleId, user, myMember, partner } = useStore()
  const { rows, reload } = useCollection('moods', coupleId)
  const today = todayStr()
  const todayRows = rows.filter((r) => r.date === today)
  const mine = todayRows.find((r) => r.user_id === user?.id) || null
  const theirs = todayRows.find((r) => r.user_id !== user?.id) || null

  const [open, setOpen] = useState(false)
  const [mood, setMood] = useState('开心')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [comforting, setComforting] = useState(false)

  const openPicker = () => {
    setMood(mine?.mood || '开心')
    setNote(mine?.note || '')
    setOpen(true)
  }

  const save = async () => {
    setSaving(true)
    const { error } = await supabase.from('moods').upsert(
      { couple_id: coupleId, user_id: user.id, mood, note: note.trim(), date: today },
      { onConflict: 'couple_id,user_id,date' },
    )
    setSaving(false)
    if (!error) {
      setOpen(false)
      reload()
    }
  }

  const comfort = async () => {
    if (comforting) return
    setComforting(true)
    await sendPoke(coupleId, user?.id, 'comfort')
    setComforting(false)
  }

  const body = (
    <>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-bold text-cocoaSoft">今天的心情</p>
        <button onClick={openPicker} className="text-xs font-bold text-rosy">
          {mine ? '改一下' : '记录我的'}
        </button>
      </div>

      <div className="space-y-3">
        <MoodRow member={myMember} row={mine} isMe />
        <MoodRow member={partner} row={theirs} />
      </div>

      {theirs && NEED_COMFORT.includes(theirs.mood) && (
        <Button variant="soft" className="mt-3 w-full" onClick={comfort} disabled={comforting}>
          {comforting ? '发送中…' : '🫂 摸摸 TA 的头'}
        </Button>
      )}

      {open && (
        <div className="mt-4 border-t border-peach/40 pt-4">
          <div className="mb-3 flex flex-wrap gap-2">
            {MOODS.map((m) => (
              <button
                key={m.value}
                onClick={() => setMood(m.value)}
                className={`rounded-full px-3 py-1.5 text-sm font-bold transition ${
                  mood === m.value ? 'bg-blush text-white' : 'bg-cream text-cocoaSoft'
                }`}
              >
                {m.emoji} {m.value}
              </button>
            ))}
          </div>
          <TextInput
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="想说点什么（可留空）"
            maxLength={40}
          />
          <Button className="mt-3 w-full" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存今天的心情'}
          </Button>
        </div>
      )}
    </>
  )

  if (bare) return <div className="rounded-card bg-white p-4 shadow-soft">{body}</div>
  return <Card>{body}</Card>
}

function MoodRow({ member, row, isMe }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-cream px-4 py-3">
      <Avatar member={member} size="md" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-bold text-cocoaSoft">
          {member?.nickname || (isMe ? '我' : 'TA')}
        </div>
        {row ? (
          <div className="truncate text-sm font-bold text-cocoa">
            {moodEmoji(row.mood)} {row.mood}
            {row.note ? <span className="ml-1 font-normal text-cocoaSoft">· {row.note}</span> : null}
          </div>
        ) : (
          <div className="text-sm text-cocoaSoft/70">今天还没记录</div>
        )}
      </div>
    </div>
  )
}
