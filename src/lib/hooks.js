import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from './supabase.js'
import { readRows, writeRows } from './collectionCache.js'
import { subscribeTable } from './realtimeBus.js'
import { columnsOf } from './tableColumns.js'

// 分页列表的首屏条数：手机一屏大约 6~9 行（照片墙 3 列更少），
// 18 条够铺满一屏再多两屏滚动，比原来的 30 条少传 40% 数据；
// 滚到底才增量加载（loadMore），首屏不为「可能要看」的内容付费。
export const PAGE_SIZE = 18

// 页面保活上下文：Dashboard 为每个常驻 tab 提供「当前是否可见」。
// useCollection 据此在隐藏页暂停 Realtime 订阅、visibilitychange/online 监听与查询，
// 切回该 tab 时自动重新订阅并补拉一次数据。全局常驻组件（Notifier/PokeListener/
// 未读中心/store）不在 Provider 内，拿到默认值 true，通知与红点链路不受影响。
export const TabActiveContext = createContext(true)

// 列表首帧用「上次打开时存下来的行」撑起画面（见 lib/collectionCache.js）。
// 目的不是少发一次请求（请求照发），而是让页面**现在**就有东西可画：
// 真数据回来后整段覆盖，React 按 key 复用节点，视觉上就是局部替换。
// 换空间时必须立刻切到新空间的缓存，否则会继续画上一个空间的内容。
// table 传的是「缓存键」（同一张表加不同过滤条件时用 cacheKey 区分，互不覆盖）。
function useCachedRows(table, coupleId) {
  const [rows, setRowsState] = useState(() => readRows(table, coupleId))
  // 包一层固定引用的 setter：下面几个 useCallback 的依赖里要写它，直接用 useState 的
  // setter 虽然本身也是稳定的，但 lint 看不出来，会一路报警告
  const setRows = useCallback((next) => setRowsState(next), [])
  const key = `${table}:${coupleId || ''}`
  const lastKey = useRef(key)
  if (lastKey.current !== key) {
    lastKey.current = key
    setRowsState(readRows(table, coupleId))
  }
  return [rows, setRows]
}

// 通用集合查询 + Realtime 实时刷新；同时暴露 reload 供增删改后手动刷新
// enabled=false 可整体停用（不查询、不订阅、不加监听）；隐藏页由 TabActiveContext 自动暂停
//
// filters: 额外过滤，两种写法：
//           [列, 值]            → eq（首页「只要今天的心情」用它，别把整张表拉下来）
//           [列, 'in', id数组]  → in（评论/回应/隐藏记录只取当前页已加载的主表行，
//                                  见 tableColumns.js 的 scopeFilter()）
//          传了就必须同时给 cacheKey —— 过滤后的结果不能覆盖全量缓存，反之亦然。
// cacheKey: 缓存/去重的逻辑表名，默认就是 table。
// columns:  select 的字段串，默认取 tableColumns.js 里登记的清单（不再 select('*')）。
// limit:    结果上限（副表放弃 id 过滤后的兜底）。
//
// 订阅走 space-<coupleId> 共享频道（lib/realtimeBus.js）：两个组件订阅同一张表
// 不会再各起一个频道，一个空间的 Realtime 连接数恒为 1。
function applyFilters(query, filters) {
  let q = query
  for (const f of filters || []) {
    // 三元组 [col, 'in', ids] 走 in，二元组 [col, val] 走 eq
    if (f.length >= 3 && f[1] === 'in') q = q.in(f[0], f[2])
    else q = q.eq(f[0], f[1])
  }
  return q
}

export function useCollection(
  table,
  coupleId,
  {
    orderBy = 'created_at',
    ascending = false,
    enabled = true,
    filters = null,
    cacheKey = null,
    columns = null,
    limit = null,
  } = {},
) {
  const tabActive = useContext(TabActiveContext)
  const active = enabled && tabActive
  const cacheName = cacheKey || table
  const [rows, setRows] = useCachedRows(cacheName, coupleId)
  const [loading, setLoading] = useState(true)
  // 过滤条件按值比较，别让「每次渲染都是新数组」把查询和订阅重挂在渲染循环上
  const filterKey = JSON.stringify(filters || null)
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  const load = useCallback(async () => {
    if (!coupleId) {
      setRows([])
      setLoading(false)
      return
    }
    // 停用/隐藏时不发查询（reload 被外部调到也是无害 no-op，切回时 effect 会补拉）
    if (!active) return
    // 只取页面要用的字段（清单见 lib/tableColumns.js）
    let q = applyFilters(
      supabase.from(table).select(columns || columnsOf(table)).eq('couple_id', coupleId),
      filtersRef.current,
    ).order(orderBy, { ascending })
    if (limit) q = q.limit(limit)
    const { data, error } = await q
    // 请求失败保留已画出来的内容：这时用空数组覆盖会闪一下「什么都没有」，
    // 而多半只是弱网抖动（成功且确实没数据时 data 是 []，不受影响）
    if (error) {
      setLoading(false)
      return
    }
    const next = data || []
    setRows(next)
    writeRows(cacheName, coupleId, next)
    setLoading(false)
    // filterKey 是 filters 的「值指纹」：调用方传的数组每次渲染都是新对象，
    // 用它当依赖才能做到「过滤值真的变了才重查」，否则每次渲染都会重发一次请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, table, cacheName, coupleId, orderBy, ascending, filterKey, columns, limit, setRows])

  useEffect(() => {
    if (!active) {
      // 停用态不显示加载骨架；rows 保留旧数据，切回时无闪烁
      setLoading(false)
      return
    }
    load()
    if (!coupleId) return
    // 共享频道：只登记「这张表有变化叫我」，不再自建频道
    return subscribeTable(coupleId, table, () => load())
  }, [load, active, coupleId, table])

  // 手机切后台再回来 / 断网重连：WebSocket 常被挂起，回到前台补拉一次
  //（隐藏页不挂监听，切回该 tab 时上面的 effect 已自动补拉，无需重复）
  useEffect(() => {
    if (!active || !coupleId) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    const onOnline = () => load()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    }
  }, [load, active, coupleId])

  return { rows, loading, reload: load }
}

// 分页版集合查询：首屏只拉最近 pageSize 条，滚动到底增量加载更早的数据。
// 适用于照片墙 / 留言流 / 日记流这类持续增长的主列表。
// 事件处理与 useCollection 同语义（任何变更 → 重拉），但重拉范围限定在
// 「已加载深度」内——不会把未加载的旧数据带回来，也不会漏掉已加载的。
// 排序固定双键 (orderBy, id)：created_at 同值（批量上传同一事务写入）时窗口不漂移。
// enabled / TabActiveContext 语义与 useCollection 完全一致。
export function usePagedCollection(
  table,
  coupleId,
  {
    orderBy = 'created_at',
    ascending = false,
    pageSize = PAGE_SIZE,
    enabled = true,
    columns = null,
  } = {},
) {
  const tabActive = useContext(TabActiveContext)
  const active = enabled && tabActive
  const [rows, setRows] = useCachedRows(table, coupleId)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const depthRef = useRef(1) // 已加载页数：事件重拉按这个深度取，loadMore 递增
  const busyRef = useRef(false) // loadMore 防重入（IntersectionObserver 回调里读 ref）

  const fetchPage = useCallback(
    async (from, to) =>
      await supabase
        .from(table)
        .select(columns || columnsOf(table)) // 只取列表要用的字段，不整行拉
        .eq('couple_id', coupleId)
        .order(orderBy, { ascending })
        .order('id', { ascending })
        .range(from, to),
    [table, coupleId, orderBy, ascending, columns],
  )

  // 按当前深度重拉（事件驱动 / reload），深度保留——不会退化回首屏
  const load = useCallback(async () => {
    if (!coupleId) {
      setRows([])
      setLoading(false)
      return
    }
    if (!active) return
    const { data, error } = await fetchPage(0, depthRef.current * pageSize - 1)
    // 请求失败保留已画出来的内容（理由同 useCollection）
    if (error) {
      setLoading(false)
      return
    }
    const next = data || []
    setRows(next)
    // 只缓存第一页：二次打开要立刻铺满首屏，翻出来的更早内容留着没意义还占配额
    writeRows(table, coupleId, next.slice(0, pageSize))
    setLoading(false)
    // 取满整页深度 = 可能还有更多；不足则已到底
    setHasMore(next.length >= depthRef.current * pageSize)
  }, [active, table, coupleId, fetchPage, pageSize, setRows])

  // 增量加载下一页：只拉新窗口，按 id 去重后追加（窗口漂移可能带来个别重复行）
  const loadMore = useCallback(async () => {
    if (busyRef.current || !hasMore || !active || !coupleId) return
    busyRef.current = true
    setLoadingMore(true)
    try {
      const from = depthRef.current * pageSize
      const { data } = await fetchPage(from, from + pageSize - 1)
      const newRows = data || []
      depthRef.current += 1
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id))
        return [...prev, ...newRows.filter((r) => !seen.has(r.id))]
      })
      setHasMore(newRows.length === pageSize)
    } finally {
      busyRef.current = false
      setLoadingMore(false)
    }
  }, [active, coupleId, fetchPage, pageSize, hasMore, setRows])

  // Realtime：与 useCollection 同构，同样挂在 space-<coupleId> 共享频道上
  useEffect(() => {
    if (!active) {
      setLoading(false)
      return
    }
    load()
    if (!coupleId) return
    return subscribeTable(coupleId, table, () => load())
  }, [load, active, coupleId, table])

  // 前台回归 / 断网重连补拉（隐藏页不挂监听，切回时上面的 effect 已自动补拉）
  useEffect(() => {
    if (!active || !coupleId) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    const onOnline = () => load()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    }
  }, [load, active, coupleId])

  return { rows, loading, loadingMore, hasMore, reload: load, loadMore }
}

// 只要最新一行（首页「最近一次戳一戳」这类展示）：limit 1，不拉历史。
// 历史数据留到用户点开明细再查（Poke.jsx 的「戳一戳记录」弹窗），
// 首页不为「今天 N 次 / 我 N 次 / TA N 次」这种统计去拉全表。
// 订阅同样走共享频道；enabled 语义与 useCollection 一致。
export function useLatestRow(
  table,
  coupleId,
  { orderBy = 'created_at', enabled = true, columns = null } = {},
) {
  const tabActive = useContext(TabActiveContext)
  const active = enabled && tabActive
  const [row, setRow] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!coupleId) {
      setRow(null)
      setLoading(false)
      return
    }
    if (!active) return
    const { data, error } = await supabase
      .from(table)
      .select(columns || columnsOf(table))
      .eq('couple_id', coupleId)
      .order(orderBy, { ascending: false })
      .limit(1)
    if (error) {
      setLoading(false)
      return
    }
    setRow(data?.[0] || null)
    setLoading(false)
  }, [active, table, coupleId, orderBy, columns])

  useEffect(() => {
    if (!active) {
      setLoading(false)
      return
    }
    load()
    if (!coupleId) return
    return subscribeTable(coupleId, table, () => load())
  }, [load, active, coupleId, table])

  return { row, loading, reload: load }
}

// ---------- 常量 ----------

export const MOODS = [
  { value: '开心', emoji: '😊' },
  { value: '甜蜜', emoji: '🥰' },
  { value: '平静', emoji: '😌' },
  { value: '想念', emoji: '🥺' },
  { value: '难过', emoji: '😢' },
  { value: '生气', emoji: '😠' },
  { value: '疲惫', emoji: '😴' },
  { value: '元气', emoji: '💪' },
]

export const AVATAR_EMOJIS = ['💕', '🐰', '🐻', '🐱', '🐶', '🌙', '⭐', '🍑', '🌸', '🐣', '🦊', '🐳']

export const NOTE_COLORS = [
  { bg: '#FBE9C8', border: '#F0D3A0' },
  { bg: '#FBD3C4', border: '#F0B49E' },
  { bg: '#F6D6DE', border: '#ECB4C4' },
  { bg: '#DDEBD6', border: '#BFD8B8' },
  { bg: '#DCE8F2', border: '#BED3E5' },
  { bg: '#EFE2F2', border: '#D9BFE2' },
]

export const WISH_CATEGORIES = [
  { key: 'place', label: '想一起去的地方', emoji: '🗺️' },
  { key: 'food', label: '想一起吃的东西', emoji: '🍜' },
  { key: 'thing', label: '想一起做的事', emoji: '🎨' },
]

// ---------- 工具 ----------

export function formatDate(d) {
  if (!d) return ''
  const dt = typeof d === 'string' ? new Date(d) : d
  const pad = (n) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}.${pad(dt.getMonth() + 1)}.${pad(dt.getDate())}`
}

// 本地时区的 YYYY-MM-DD（不要用 toISOString，会差 8 小时）
export function todayStr(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function formatDateTime(d) {
  if (!d) return ''
  const dt = typeof d === 'string' ? new Date(d) : d
  const pad = (n) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}.${pad(dt.getMonth() + 1)}.${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

// 指定时区的当前本地时间
export function timeInZone(timezone) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone,
    }).format(new Date())
  } catch {
    return ''
  }
}

export function detectTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'Asia/Shanghai'
  }
}
