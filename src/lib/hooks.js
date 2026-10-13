import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { supabase } from './supabase.js'

// 页面保活上下文：Dashboard 为每个常驻 tab 提供「当前是否可见」。
// useCollection 据此在隐藏页暂停 Realtime 订阅、visibilitychange/online 监听与查询，
// 切回该 tab 时自动重新订阅并补拉一次数据。全局常驻组件（Notifier/PokeListener/
// 未读中心/store）不在 Provider 内，拿到默认值 true，通知与红点链路不受影响。
export const TabActiveContext = createContext(true)

// 通用集合查询 + Realtime 实时刷新；同时暴露 reload 供增删改后手动刷新
// enabled=false 可整体停用（不查询、不订阅、不加监听）；隐藏页由 TabActiveContext 自动暂停
export function useCollection(table, coupleId, { orderBy = 'created_at', ascending = false, enabled = true } = {}) {
  const tabActive = useContext(TabActiveContext)
  const active = enabled && tabActive
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  // 每个订阅实例用唯一的频道名：supabase.channel() 同名时会复用旧实例，
  // 两个组件订阅同一张表（例如磁贴 + 弹窗）会互相干扰
  const channelName = useMemo(
    () => `realtime-${table}-${coupleId}-${Math.random().toString(36).slice(2, 8)}`,
    [table, coupleId],
  )

  const load = useCallback(async () => {
    if (!coupleId) {
      setRows([])
      setLoading(false)
      return
    }
    // 停用/隐藏时不发查询（reload 被外部调到也是无害 no-op，切回时 effect 会补拉）
    if (!active) return
    const { data } = await supabase
      .from(table)
      .select('*')
      .eq('couple_id', coupleId)
      .order(orderBy, { ascending })
    setRows(data || [])
    setLoading(false)
  }, [active, table, coupleId, orderBy, ascending])

  useEffect(() => {
    if (!active) {
      // 停用态不显示加载骨架；rows 保留旧数据，切回时无闪烁
      setLoading(false)
      return
    }
    load()
    if (!coupleId) return
    const channel = supabase
      .channel(channelName)
      // 主监听：带 couple_id 过滤，精确命中本空间的增/改（删）
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `couple_id=eq.${coupleId}` },
        () => load(),
      )
      // 兜底监听：Postgres 的 DELETE 事件默认只带主键，服务端的 couple_id 过滤匹配不到。
      // 这里在客户端按旧行过滤：表设了 REPLICA IDENTITY FULL 时 old 带 couple_id，
      // 非本空间的删除直接忽略，避免全表无过滤刷新；旧行没有 couple_id 时保守刷新
      //（宁可多刷不可漏刷）。表若已设 FULL，第一条监听即可命中，这条只是双保险。
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table }, (payload) => {
        const oldCoupleId = payload?.old?.couple_id
        if (oldCoupleId === undefined || oldCoupleId === coupleId) load()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [load, active, coupleId, table, channelName])

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
  { orderBy = 'created_at', ascending = false, pageSize = 30, enabled = true } = {},
) {
  const tabActive = useContext(TabActiveContext)
  const active = enabled && tabActive
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const depthRef = useRef(1) // 已加载页数：事件重拉按这个深度取，loadMore 递增
  const busyRef = useRef(false) // loadMore 防重入（IntersectionObserver 回调里读 ref）
  const channelName = useMemo(
    () => `paged-${table}-${coupleId}-${Math.random().toString(36).slice(2, 8)}`,
    [table, coupleId],
  )

  const fetchPage = useCallback(
    async (from, to) =>
      await supabase
        .from(table)
        .select('*')
        .eq('couple_id', coupleId)
        .order(orderBy, { ascending })
        .order('id', { ascending })
        .range(from, to),
    [table, coupleId, orderBy, ascending],
  )

  // 按当前深度重拉（事件驱动 / reload），深度保留——不会退化回首屏
  const load = useCallback(async () => {
    if (!coupleId) {
      setRows([])
      setLoading(false)
      return
    }
    if (!active) return
    const { data } = await fetchPage(0, depthRef.current * pageSize - 1)
    setRows(data || [])
    setLoading(false)
    // 取满整页深度 = 可能还有更多；不足则已到底
    setHasMore((data || []).length >= depthRef.current * pageSize)
  }, [active, coupleId, fetchPage, pageSize])

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
  }, [active, coupleId, fetchPage, pageSize, hasMore])

  // Realtime：与 useCollection 同构（主监听带 couple_id 过滤 + DELETE 兜底按旧行过滤）
  useEffect(() => {
    if (!active) {
      setLoading(false)
      return
    }
    load()
    if (!coupleId) return
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `couple_id=eq.${coupleId}` },
        () => load(),
      )
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table }, (payload) => {
        const oldCoupleId = payload?.old?.couple_id
        if (oldCoupleId === undefined || oldCoupleId === coupleId) load()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [load, active, coupleId, table, channelName])

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
