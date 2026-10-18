// ============================================================
//  矛盾处理室：文案与规则常量
//
//  产品边界（决定了这里的每一句话怎么写）：
//    · 不判断对错、不催和好：结束态只有「双方同意结束 / 时间到」，没有「已和好」；
//    · 等对方不是惩罚：等待文案要让人放松，不能暗示「你在逃避」；
//    · 拒绝与不处理同样是正常选择，文案里不出现「逃避 / 伤害关系」这类词；
//    · 过滤只能承诺「拦截部分明确攻击性表达」，不能承诺房间里没有负面情绪。
// ============================================================

export const MIN_LEN = 10

// 拦截提示（服务端与客户端同一句，避免两处文案不一致）
export const BLOCKED_TIP = '请平复你的情绪，上头只会破坏双方的感情。'
export const TOO_SHORT_TIP = `再多写一点吧，至少 ${MIN_LEN} 个字`
export const EMPTY_TIP = '内容不能只是标点或空白'

// 时长选项（秒）；自定义走同一个输入框，服务端再夹到 5~120 分钟
export const DURATION_OPTIONS = [
  { label: '10 分钟', seconds: 600 },
  { label: '20 分钟', seconds: 1200 },
  { label: '30 分钟', seconds: 1800 },
]

// 结束后双方各记各的状态：不覆盖对方，也不自动等于「已和好」
export const FEEDBACK_OPTIONS = [
  { value: 'resolved', label: '已解决', emoji: '🌤️' },
  { value: 'eased', label: '有所缓和', emoji: '🍃' },
  { value: 'need_more', label: '还需要继续沟通', emoji: '🫱' },
  { value: 'none', label: '暂时不想评价', emoji: '🕊️' },
]

export const FEEDBACK_LABEL = Object.fromEntries(FEEDBACK_OPTIONS.map((o) => [o.value, o.label]))

// 房间状态：只描述事实，不做价值判断
export const STATUS_LABEL = {
  invited: '等待 TA 加入',
  active: '沟通中',
  cancelled: '邀请已取消',
  declined: 'TA 这次先不聊',
  invite_expired: '邀请已结束',
  ended_agreed: '双方已结束本次沟通',
  timed_out: '本次沟通时间到了',
}

export const HISTORY_TIP = '本次沟通时间到了。房间记录已保存，先让情绪沉淀一下。'

/**
 * 发言内容校验（客户端先拦一次，服务端 send_conflict_room_message 再拦一次）。
 * 保护的是「能不能好好说」，不是「能不能说负面感受」——
 * 生气、不同意、受伤这类表达必须放行。
 * @returns {{ok: boolean, reason?: string, blocked?: boolean}}
 */
export function validateBody(body, words = []) {
  const text = (body || '').trim()
  if (text.length < MIN_LEN) return { ok: false, reason: `${TOO_SHORT_TIP}（现在 ${text.length} 个）` }
  // 中文全角标点不在 \p{P} 的常见实现里，显式列出来
  const stripped = text.replace(/[\s\p{P}、，。！？；：（）《》【】…—～“”‘’]/gu, '')
  if (stripped.length === 0) return { ok: false, reason: EMPTY_TIP }
  for (const w of words) {
    if (w && text.includes(w)) return { ok: false, reason: BLOCKED_TIP, blocked: true }
  }
  return { ok: true }
}

/** 剩余秒数 → mm:ss（到期统一显示 00:00，不出现负数） */
export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

/** 时长（秒）→「20 分钟」 */
export function formatDuration(seconds) {
  const m = Math.round((seconds || 0) / 60)
  return `${m} 分钟`
}
