// 最近删除通用逻辑：删除后躺 N 天，期间可恢复，到期自动清除
// v2：不再依赖 trash_bin 表——日记用自身的 deleted_at，语音用 message_hidden.created_at 推导
export const TRASH_DAYS = 3
// 照片/图集双方共同的回忆，保留久一点
export const PHOTO_TRASH_DAYS = 30

// 删除时间 + N 天 = 到期时间
export const expireAt = (deletedAtIso, days = TRASH_DAYS) =>
  new Date(deletedAtIso).getTime() + days * 86400000

export const isExpiredAt = (deletedAtIso, days = TRASH_DAYS) => expireAt(deletedAtIso, days) <= Date.now()

// 剩余天数：不足一天也按 1 天算，避免刚删就显示"今天到期"
export const daysLeft = (deletedAtIso, days = TRASH_DAYS) =>
  Math.max(1, Math.ceil((expireAt(deletedAtIso, days) - Date.now()) / 86400000))

export const leftLabel = (deletedAtIso, days = TRASH_DAYS) => `还剩 ${daysLeft(deletedAtIso, days)} 天`
