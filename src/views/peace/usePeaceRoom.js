// 矛盾处理室：房间内的消息、发言权、倒计时与结束流程
//
// 三条铁律（037 的 RPC 在服务端也各守一遍，这里只是让体验更顺）：
//   1. 只有轮到自己时输入框才可用 —— 不是靠 disable 挡住，服务端才是权威；
//   2. 发送失败保留输入内容、不切换发言权；重试带同一个幂等 ID，不会插两条；
//   3. 倒计时只负责显示，到没到期看服务端 expires_at（本地时钟先用 server_now 校准）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useCollection } from '../../lib/hooks.js'
import { useToast } from '../../lib/toast.jsx'
import { validateBody } from './constants.js'

// ---------- 服务器时间校准 ----------
// 手机的系统时间可能不准，跨时区也可能差好几分钟；拿 server_now() 校准一次，
// 之后倒计时 = expires_at - (Date.now() + offset)。
let clockOffset = null
let clockPending = null

export async function syncServerClock() {
  if (clockOffset !== null) return clockOffset
  if (!clockPending) {
    clockPending = (async () => {
      const t0 = Date.now()
      const { data, error } = await supabase.rpc('server_now')
      if (error || !data) {
        clockOffset = 0 // 拿不到就按本地时间走，到期判定仍以服务端为准
        return clockOffset
      }
      const t1 = Date.now()
      const serverMs = new Date(data).getTime()
      clockOffset = serverMs - Math.round((t0 + t1) / 2)
      return clockOffset
    })().finally(() => {
      clockPending = null
    })
  }
  return clockPending
}

// ---------- 辱骂词表（前端先拦一次，别让用户白等一个来回） ----------
let wordsCache = null
let wordsPending = null

export async function loadBlockedWords() {
  if (wordsCache) return wordsCache
  if (!wordsPending) {
    wordsPending = supabase
      .from('conflict_room_blocked_words')
      .select('word')
      .then(({ data, error }) => {
        wordsCache = error ? [] : (data || []).map((r) => r.word)
        return wordsCache
      })
      .finally(() => {
        wordsPending = null
      })
  }
  return wordsPending
}

export function usePeaceRoom({ room, coupleId, user, active = true }) {
  const toast = useToast()
  const roomId = room?.id || null
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [words, setWords] = useState([])
  // 幂等 ID：一次「组织语言 → 发送」共用同一个，失败重试不会插出两条
  const msgIdRef = useRef(null)

  const { rows: messages, loading, reload } = useCollection('conflict_room_messages', coupleId, {
    // ⚠ 二元组才是 eq（三元组里只有 'in' 被识别，写成 ['room_id','eq',id] 会变成 eq('room_id','eq')）
    filters: roomId ? [['room_id', roomId]] : null,
    cacheKey: roomId ? `conflict_room_messages:${roomId}` : null,
    orderBy: 'created_at',
    ascending: true,
    enabled: !!roomId && active,
  })
  const { rows: feedbackRows, reload: reloadFeedback } = useCollection('conflict_room_feedback', coupleId, {
    // ⚠ 二元组才是 eq（三元组里只有 'in' 被识别，写成 ['room_id','eq',id] 会变成 eq('room_id','eq')）
    filters: roomId ? [['room_id', roomId]] : null,
    cacheKey: roomId ? `conflict_room_feedback:${roomId}` : null,
    enabled: !!roomId && active,
  })

  useEffect(() => {
    let alive = true
    loadBlockedWords().then((w) => {
      if (alive) setWords(w)
    })
    return () => {
      alive = false
    }
  }, [])

  // 换房间时清掉输入框：上一条已经发出去了，别把上文的字带到下一段
  useEffect(() => {
    setText('')
    msgIdRef.current = null
  }, [roomId])

  const myId = user?.id || null
  const isMine = useCallback((uid) => !!myId && uid === myId, [myId])
  const myTurn = !!room && room.status === 'active' && room.turn_user_id === myId
  const isParticipant = !!room && (room.created_by === myId || room.invited_user_id === myId)
  const ended = !!room && ['ended_agreed', 'timed_out', 'cancelled', 'declined', 'invite_expired'].includes(room.status)
  const myFeedback = feedbackRows.find((f) => f.user_id === myId) || null
  const partnerFeedback = feedbackRows.find((f) => f.user_id && f.user_id !== myId) || null

  // ---------- 倒计时：显示用本地时钟 + 校准偏移，判定一律看服务端 ----------
  const [offset, setOffset] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let alive = true
    syncServerClock().then((o) => {
      if (alive) setOffset(o)
    })
    return () => {
      alive = false
    }
  }, [])

  const expiredRef = useRef(false)
  const remainMs = useMemo(() => {
    if (!room?.expires_at) return 0
    const end = new Date(room.expires_at).getTime()
    return Math.max(0, end - (now + offset))
  }, [room?.expires_at, now, offset])

  useEffect(() => {
    if (!active || room?.status !== 'active') return
    expiredRef.current = false
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, room?.status, roomId])

  // 归零：让服务端把房间落定（我们只是通知，状态由它改）
  useEffect(() => {
    if (!active || room?.status !== 'active' || remainMs > 0 || expiredRef.current) return
    expiredRef.current = true
    supabase.rpc('close_expired_conflict_rooms').then(() => {
      reload()
      reloadFeedback()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, room?.status, remainMs, roomId])

  const run = useCallback(
    async (fn, args, { ok = null, silent = false } = {}) => {
      const { data, error } = await supabase.rpc(fn, args)
      if (error) {
        toast.error(error.message || '操作失败，请重试')
        return { data: null, error }
      }
      if (ok && !silent) toast.success(ok)
      await reload()
      return { data, error: null }
    },
    [reload, toast],
  )

  // ---------- 发言 ----------
  const send = useCallback(async () => {
    if (!roomId || sending) return { ok: false }
    const v = validateBody(text, words)
    if (!v.ok) {
      toast.warning(v.reason)
      // 被词表拦了：给一个「反馈误拦截」的入口，但只记「命中了」，不记原文
      if (v.blocked) {
        supabase.rpc('report_conflict_room_filter_hit', { p_room_id: roomId }).catch(() => {})
      }
      return { ok: false, reason: v.reason }
    }
    if (!msgIdRef.current) {
      msgIdRef.current = `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    }
    setSending(true)
    // ⚠ 直接调 rpc 而不是走 run()：要区分「报错」与「房间刚被判超时」。
    //   过期时服务端会把房间改成 timed_out 并**正常返回**（返回空 = 没有消息写入），
    //   这样状态才落得住（在 RPC 里「更新完再抛异常」会被整个事务回滚）。
    const { data, error } = await supabase.rpc('send_conflict_room_message', {
      p_room_id: roomId,
      p_body: text.trim(),
      p_client_msg_id: msgIdRef.current,
    })
    setSending(false)
    if (error) {
      toast.error(error.message || '发送失败，请重试')
      return { ok: false, error } // 保留输入内容，发言权也没变
    }
    if (!data) {
      toast.warning('本次沟通时间到了，房间已结束')
      await reload()
      return { ok: false, reason: 'timed_out' }
    }
    setText('')
    msgIdRef.current = null
    await reload()
    return { ok: true }
  }, [roomId, sending, text, words, reload, toast])

  const requestEnd = useCallback(
    () => run('request_conflict_room_end', { p_room_id: roomId }, { ok: '已发出结束申请' }),
    [roomId, run],
  )
  const respondEnd = useCallback(
    (approve) =>
      run('respond_conflict_room_end', { p_room_id: roomId, p_approve: approve }, {
        ok: approve ? '本次沟通已结束' : '已拒绝，房间继续',
      }),
    [roomId, run],
  )
  const setFeedback = useCallback(
    async (status) => {
      const { error } = await run('set_conflict_room_feedback', { p_room_id: roomId, p_status: status }, { ok: '已记录' })
      if (!error) await reloadFeedback()
    },
    [roomId, run, reloadFeedback],
  )

  return {
    messages,
    loading,
    reload,
    text,
    setText,
    send,
    sending,
    myTurn,
    isMine,
    isParticipant,
    ended,
    remainMs,
    myFeedback,
    partnerFeedback,
    requestEnd,
    respondEnd,
    setFeedback,
  }
}
