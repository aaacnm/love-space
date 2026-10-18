// 矛盾处理室：房间列表与「发起 / 加入 / 拒绝 / 取消」动作
//
// 所有状态流转都走服务端 RPC（037）：客户端只是把按钮点出去，
// 「谁先说、时间到没到、能不能结束」全部由数据库判定，前端骗不过去。
import { useCallback, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useCollection } from '../../lib/hooks.js'
import { useToast } from '../../lib/toast.jsx'

export function usePeaceRooms({ coupleId, enabled = true }) {
  const toast = useToast()
  const { rows, loading, reload } = useCollection('conflict_rooms', coupleId, { enabled })
  const [busy, setBusy] = useState(false)

  // 统一的调用壳：失败只在 toast 里说一次，成功交给调用方刷新
  const run = useCallback(
    async (fn, args, { ok = null, silent = false } = {}) => {
      setBusy(true)
      try {
        const { data, error } = await supabase.rpc(fn, args)
        if (error) throw error
        if (ok && !silent) toast.success(ok)
        await reload()
        return { data, error: null }
      } catch (e) {
        toast.error(e?.message || '操作失败，请重试')
        return { data: null, error: e }
      } finally {
        setBusy(false)
      }
    },
    [reload, toast],
  )

  const createRoom = useCallback(
    (seconds, note) => run('create_conflict_room', { p_duration_seconds: seconds, p_note: note || null }, { ok: '邀请已发出' }),
    [run],
  )
  const joinRoom = useCallback(
    (roomId, accept) =>
      run('join_conflict_room', { p_room_id: roomId, p_accept: accept }, {
        ok: accept ? '已加入，从现在开始计时' : '已回复 TA：这次先不聊',
      }),
    [run],
  )
  const cancelRoom = useCallback(
    (roomId) => run('cancel_conflict_room', { p_room_id: roomId }, { ok: '邀请已取消' }),
    [run],
  )
  // 回到页面时先把「离线期间已经到期」的房间落定（不看客户端计时器）
  const closeExpired = useCallback(
    () => run('close_expired_conflict_rooms', {}, { silent: true }),
    [run],
  )

  return { rooms: rows, loading, reload, busy, createRoom, joinRoom, cancelRoom, closeExpired }
}
