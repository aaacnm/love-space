// 留言板的常量与纯展示工具：从 Messages.jsx 原样搬出，供页面与卡片组件共用。
// 注意：monthKey / dayKey 必须走本地时区（created_at 是 UTC，直接切字符串会差 8 小时）。
import { NOTE_COLORS } from '../../lib/hooks.js'

// 灯箱/大图按需单签 + 图片变换（contain 等比适配，不放大不加边）
export const PREVIEW_TF = { height: 1280, resize: 'contain' }

// 表情回应的可选 emoji（消息底部 😊+ 弹出）
export const REACTION_EMOJIS = ['💗', '👍', '😂', '😮', '😢', '💪']

// 根据 id 稳定地选一个便利贴颜色
export function noteStyle(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return { color: NOTE_COLORS[h % NOTE_COLORS.length] }
}

// 一条留言的一句摘要（引用条 / 评论弹窗顶部用）
export const digest = (m, n = 40) => {
  if (!m) return '（已删除）'
  if (m.content) return m.content.length > n ? m.content.slice(0, n) + '…' : m.content
  if (m.voice_path) return `[语音 ${m.voice_seconds || '?'}″]`
  if (m.image_path) return '[图片]'
  return '[留言]'
}

// 本地时区的 YYYY-MM / YYYY-MM-DD（created_at 是 UTC，直接 toISOString 会差 8 小时）
export const monthKey = (iso) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
export const dayKey = (iso) => {
  const d = new Date(iso)
  return `${monthKey(iso)}-${String(d.getDate()).padStart(2, '0')}`
}
export const monthLabel = (key) => {
  const [y, m] = key.split('-')
  return Number(m) === new Date().getMonth() + 1 && Number(y) === new Date().getFullYear()
    ? '本月'
    : `${y}年${Number(m)}月`
}
