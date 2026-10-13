import { useState } from 'react'
import { useStore } from '../lib/store.jsx'
import { supabase } from '../lib/supabase.js'
import { toast } from '../lib/toast.jsx'
import { leaveCouple } from '../lib/couple.js'
import { Modal, Button } from './ui.jsx'
import { Avatar } from './Avatar.jsx'

export default function ManageMembersModal({ open, onClose }) {
  const { members, user, refresh, leaveSpace } = useStore()
  const [confirmId, setConfirmId] = useState(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [busy, setBusy] = useState(false)

  const remove = async (member) => {
    // 两段确认：第一次点击进入确认态，再点一次才真正移除
    if (confirmId !== member.id) {
      setConfirmId(member.id)
      return
    }
    setBusy(true)
    const { error } = await supabase.from('members').delete().eq('id', member.id)
    setBusy(false)
    setConfirmId(null)
    if (!error) await refresh()
  }

  const leave = async () => {
    // 两段确认：第一次点击进入确认态，再点一次才真正退出
    if (!confirmLeave) {
      setConfirmLeave(true)
      return
    }
    setBusy(true)
    try {
      await leaveCouple()
      leaveSpace()
      onClose()
    } catch (e) {
      toast.error('退出空间失败：' + (e?.message || '请稍后重试'))
    } finally {
      setBusy(false)
      setConfirmLeave(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="管理成员">
      <div className="space-y-3">
        {members.map((m) => {
          const isSelf = m.user_id === user?.id
          return (
            <div key={m.id} className="flex items-center justify-between rounded-2xl bg-white px-4 py-3 shadow-soft">
              <div className="flex items-center gap-3">
                <Avatar member={m} size="md" />
                <div>
                  <div className="font-bold text-cocoa">
                    {m.nickname}
                    {isSelf && <span className="ml-1 text-xs font-normal text-cocoaSoft">（我）</span>}
                  </div>
                  <div className="text-xs text-cocoaSoft">{m.city || '未填写城市'}</div>
                </div>
              </div>
              {isSelf ? (
                <Button
                  variant={confirmLeave ? 'primary' : 'ghost'}
                  onClick={leave}
                  disabled={busy}
                  className="px-3 py-1.5 text-sm"
                >
                  {confirmLeave ? '确认退出？' : '退出空间'}
                </Button>
              ) : (
                <Button
                  variant={confirmId === m.id ? 'primary' : 'ghost'}
                  onClick={() => remove(m)}
                  disabled={busy}
                  className="px-3 py-1.5 text-sm"
                >
                  {confirmId === m.id ? '确认移除？' : '移除'}
                </Button>
              )}
            </div>
          )
        })}
        <p className="text-xs text-cocoaSoft/70">移除后对方会回到引导页；空间里的日记、照片等数据仍保留。</p>
        <p className="text-xs text-cocoaSoft/70">退出后你发布的日记、照片等仍保留在空间里，可用原情侣码随时重新加入查看。</p>
      </div>
    </Modal>
  )
}
