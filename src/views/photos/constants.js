// 照片墙的常量与纯展示工具：从 Photos.jsx 抽出来，供页面与子组件共用。

// photos 已转私有桶：展示一律走签名 URL（lib/storage.js，带内存缓存）
//
// ⚠️ 网格/封面/回收站**只允许加载缩略图**，绝不回退 storage_path 原图：
// 一张老照片的原图动辄几 MB，列表一屏十几张就能吃掉几十 MB 流量。
// 缺 thumb_path 的旧照片由 useThumbSrcs 走「服务端 480 变换」兜底（同样是几十 KB）。
export const thumbPathOf = (p) => p.thumb_path || null

// 480 / 1280 两档图片变换的**唯一定义**在 lib/mediaUrls.js（留言、日记也用它）；
// 这里转出是为了不让既有 import 到处改。改尺寸请改那边。
export { THUMB_TF, PREVIEW_TF } from '../../lib/mediaUrls.js'

export const MAX_PICK = 9
export const UPLOAD_CONCURRENCY = 3

// ---------- 记忆空间的小工具 ----------

// 「2026年3月」月份粒度（图集时间范围用）
export const fmtMonth = (iso) => {
  const d = new Date(iso)
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
}
// 完整日期（随机回忆用）
export const fmtFullDate = (iso) => {
  const d = new Date(iso)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}
// 「多久之前」——给回忆加一层滤镜
export const relTime = (iso) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (days <= 0) return '今天'
  if (days < 30) return `${days} 天前`
  if (days < 365) return `${Math.floor(days / 30.44)} 个月前`
  const y = Math.floor(days / 365.25)
  const restM = Math.round((days - y * 365.25) / 30.44)
  return restM >= 1 ? `${y} 年 ${restM} 个月前` : `${y} 年前`
}

// 浏览方式（网格/时间线）按 userId + coupleId 双维度隔离——同一浏览器换账号/换空间互不串扰，
// 结构与未读基线一致：love_photos_browse_v1_<uid> = { couples: { <cid>: { mode, t } } }，最多保留 4 个空间
export const browseKeyOf = (uid) => `love_photos_browse_v1_${uid}`
export const loadBrowse = (uid, cid) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(browseKeyOf(uid || '')) || 'null')
    return parsed?.couples?.[cid]?.mode || 'grid'
  } catch {
    return 'grid'
  }
}
export const saveBrowse = (uid, cid, mode) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(browseKeyOf(uid || '')) || 'null')
    const couples = { ...(parsed?.couples || {}) }
    couples[cid] = { mode, t: Date.now() }
    const keep = Object.entries(couples)
      .sort((a, b) => (b[1]?.t || 0) - (a[1]?.t || 0))
      .slice(0, 4)
    localStorage.setItem(browseKeyOf(uid || ''), JSON.stringify({ couples: Object.fromEntries(keep) }))
  } catch {
    /* 隐私模式等场景下存不了就算了 */
  }
}
