// 列表数据缓存：唯一用途是「先把上次看到的内容画出来」。
//
// 它不参与任何权限判定：真正的可见性仍由 Supabase RLS 在后台请求里裁定，
// 后台回来的新数据会整段覆盖缓存；无权限的数据后台拿不到，页面自然不会显示。
// 因此这里的语义必须是「可能过期的快速占位」，不是数据源。
//
// 三条约束：
// 1) key 里带 coupleId —— 换空间不能串数据；
// 2) 条数与体积双上限 —— 不能把 localStorage 打爆（留言正文可能很长）；
// 3) 任何异常都吞掉 —— 隐私模式 / 配额满是真实存在的，缓存失败只能降级，不能崩页面。
const NS = 'love.list.v1'
const MAX_ROWS = 60 // 只留够铺满一屏的量，再多没意义
const MAX_CHARS = 200_000 // 单条集合序列化上限，超出就不写
const TTL = 7 * 24 * 60 * 60 * 1000 // 超过一周没刷新过的缓存直接作废

const keyOf = (table, coupleId) => `${NS}:${table}:${coupleId}`

function store() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null // 极少数环境访问 localStorage 本身就会抛（被策略禁用）
  }
}

export function listCacheKey(table, coupleId) {
  return keyOf(table, coupleId)
}

export function readRows(table, coupleId) {
  const ls = store()
  if (!ls || !table || !coupleId) return []
  try {
    const raw = ls.getItem(keyOf(table, coupleId))
    if (!raw) return []
    const rec = JSON.parse(raw)
    if (!Array.isArray(rec?.rows)) return []
    if (!rec.savedAt || Date.now() - rec.savedAt > TTL) {
      ls.removeItem(keyOf(table, coupleId))
      return []
    }
    return rec.rows
  } catch {
    return [] // 缓存坏了就当没缓存
  }
}

export function writeRows(table, coupleId, rows) {
  const ls = store()
  if (!ls || !table || !coupleId) return
  const key = keyOf(table, coupleId)
  const list = Array.isArray(rows) ? rows.slice(0, MAX_ROWS) : []
  if (list.length === 0) {
    // 空结果也要覆盖：全部删完之后不该在下一次打开时又冒出来
    try {
      ls.removeItem(key)
    } catch {
      /* noop */
    }
    return
  }
  try {
    const raw = JSON.stringify({ savedAt: Date.now(), rows: list })
    if (raw.length > MAX_CHARS) {
      // 太长宁可不缓存：占着配额却换不来几毫秒，不如留给别人
      try {
        ls.removeItem(key)
      } catch {
        /* noop */
      }
      return
    }
    ls.setItem(key, raw)
  } catch {
    /* 配额满 / 隐私模式：写不进去不影响使用 */
  }
}

export function clearRows(table, coupleId) {
  const ls = store()
  if (!ls) return
  try {
    ls.removeItem(keyOf(table, coupleId))
  } catch {
    /* noop */
  }
}

// 清掉本命名空间下所有缓存（退出空间 / 测试隔离用）
export function clearAllRows() {
  const ls = store()
  if (!ls) return
  try {
    const doomed = []
    for (let i = 0; i < ls.length; i += 1) {
      const k = ls.key(i)
      if (k && k.startsWith(`${NS}:`)) doomed.push(k)
    }
    doomed.forEach((k) => ls.removeItem(k))
  } catch {
    /* noop */
  }
}
