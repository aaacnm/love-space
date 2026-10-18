// 邀请卡片上的两个按钮：受邀方「加入 / 这次先不聊」，发起方「取消邀请」
//
// 拒绝与不处理都是正常选择：文案只说事实（「这次先不聊」），
// 不出现「逃避」「伤害关系」这类压力词，也不反复催促。
import { Button } from '../../components/ui.jsx'

export default function PeaceInviteActions({ room, userId, busy, onJoin, onCancel }) {
  const iAmInviter = room.created_by === userId
  const iWasInvited = room.invited_user_id === userId
  if (!iAmInviter && !iWasInvited) return null

  if (iAmInviter) {
    return (
      <Button variant="ghost" className="py-2 text-sm" disabled={busy} onClick={() => onCancel(room.id)}>
        取消邀请
      </Button>
    )
  }

  return (
    <div className="flex gap-2">
      <Button variant="primary" className="py-2 text-sm" disabled={busy} onClick={() => onJoin(room.id, true)}>
        加入
      </Button>
      <Button variant="ghost" className="py-2 text-sm" disabled={busy} onClick={() => onJoin(room.id, false)}>
        这次先不聊
      </Button>
    </div>
  )
}
