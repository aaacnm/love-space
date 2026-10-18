import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { supabase } from './supabase.js'
import { useStore } from './store.jsx'
import { subscribeTable } from './realtimeBus.js'
import { whenIdle } from './idle.js'

// ============================================================
// 统一「未读和提醒」机制
//   messages: TA 的新留言/语音/留言回复 → 留言页红点，进入页面自动清除
//   diary:    TA 评论了日记             → 日记页红点，进入页面自动清除
//   chat:     TA 发起「想聊聊」         → 留言页脉冲红点（高优先级），进入留言页清除
//   pokes:    TA 戳了戳我 / 摸摸头      → 首页卡片提醒，点条目清除
//   mood:     TA 记录/更新了心情        → 首页卡片提醒，点条目清除
//
// 实现：读到哪了的「基线」按 用户+空间 双维度存 localStorage（跨会话存活，
// 重开 App 也能补出未读；退出空间再加入新空间时基线互不串扰，旧版扁平
// 结构自动迁移）。计数 = 轻量 count 查询（created_at > 基线 且作者 = 对方），
// 实时事件防抖重查 + 回前台/联网/每分钟兜底重查。不新增数据库表、零迁移。
//
// 首屏纪律：这一组统计（5 条查询）只是给红点和首页卡片用的，晚几百毫秒补上
// 用户无感，所以第一次刷新推迟到首屏画完之后（whenIdle），不和首页真正要
// 显示的内容（今天的心情 / 最近一条戳）抢带宽。订阅挂在 space-<coupleId>
// 共享频道上，不再单独建频道。
// ============================================================

const KEY_PREFIX = 'love_unread_v1_'
const EMPTY = { messages: null, diary: null, pokes: null, mood: null, moodInit: false }
// 每个用户最多保留最近 N 个空间的基线：换过几次空间也不会无限增长
const MAX_COUPLES = 4

function loadState(uid, coupleId) {
  if (!uid || !coupleId) return null
  try {
    const raw = localStorage.getItem(KEY_PREFIX + uid)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.couples) {
      const entry = parsed.couples[coupleId]
      return entry ? { ...EMPTY, ...entry } : null
    }
    // 旧版扁平结构（只按 uid 存）：视为升级时所在空间的基线迁移过来，
    // 老用户的未读状态不丢
    if (parsed && typeof parsed === 'object') return { ...EMPTY, ...parsed }
  } catch {
    /* 坏数据当没有 */
  }
  return null
}

function saveState(uid, coupleId, s) {
  if (!uid || !coupleId) return
  try {
    let rec = { couples: {} }
    try {
      const raw = localStorage.getItem(KEY_PREFIX + uid)
      const parsed = raw && JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.couples) rec = parsed
      else if (parsed && typeof parsed === 'object') rec = { couples: { [coupleId]: parsed } }
    } catch {
      /* 旧数据坏了就重开一份 */
    }
    rec.couples[coupleId] = { ...s, t: Date.now() }
    // 只保留最近访问的几个空间
    const entries = Object.entries(rec.couples).sort((a, b) => (b[1].t || 0) - (a[1].t || 0))
    if (entries.length > MAX_COUPLES) rec.couples = Object.fromEntries(entries.slice(0, MAX_COUPLES))
    localStorage.setItem(KEY_PREFIX + uid, JSON.stringify(rec))
  } catch {
    /* 隐私模式写不进去就算了：未读只活在本会话 */
  }
}

const UnreadContext = createContext(null)

export function UnreadProvider({ activeTab, children }) {
  const { coupleId, user, partner } = useStore()
  const [counts, setCounts] = useState({ messages: 0, diary: 0, chat: false, pokes: 0, mood: null })
  const stateRef = useRef({ uid: null, coupleId: null, s: { ...EMPTY } })
  const activeRef = useRef(activeTab)
  const lastMoodRef = useRef(null) // 最近一次查到的对方心情行（markSeen 用它更新快照）
  const refreshRef = useRef(null)
  const markSeenRef = useRef(() => {})
  const debounceRef = useRef(null)

  const persist = useCallback(() => {
    const { uid, coupleId, s } = stateRef.current
    if (uid && coupleId) saveState(uid, coupleId, s)
  }, [stateRef])

  // ---- 基线初始化：按 用户+空间 维度，首次进入某空间以「现在」为基线 ----
  // （退出旧空间再加入新空间：新空间基线全新，旧内容不淹没；切回旧空间恢复其原状态）
  const ensureBaseline = useCallback(() => {
    const uid = user?.id
    if (!uid || !coupleId) return
    const cur = stateRef.current
    if (cur.uid === uid && cur.coupleId === coupleId) return
    const stored = loadState(uid, coupleId)
    const base = stored || { ...EMPTY }
    if (!stored) {
      const now = new Date().toISOString()
      base.messages = now
      base.diary = now
      base.pokes = now
      saveState(uid, coupleId, base)
    }
    stateRef.current = { uid, coupleId, s: base }
  }, [user?.id, coupleId, stateRef])

  // ---- 计数：一组轻量查询（count/head 不拉数据） ----
  const refresh = useCallback(async () => {
    ensureBaseline()
    const uid = user?.id
    if (!uid || !coupleId) return
    const s = stateRef.current.s
    const partnerId = partner?.user_id
    try {
      const headCount = async (table, authorCol, since) => {
        if (!since) return 0
        const { count } = await supabase
          .from(table)
          .select('id', { count: 'exact', head: true })
          .eq('couple_id', coupleId)
          .neq(authorCol, uid)
          .gt('created_at', since)
        return count || 0
      }
      const [nMsg, nMsgCmt, nDiaryCmt] = await Promise.all([
        headCount('messages', 'author_user_id', s.messages),
        headCount('message_comments', 'author_user_id', s.messages),
        headCount('diary_comments', 'author_user_id', s.diary),
      ])

      // 戳一戳家族：分出高优先级的「想聊聊」和普通戳
      let chat = false
      let pokes = 0
      if (s.pokes) {
        const { data } = await supabase
          .from('pokes')
          .select('kind')
          .eq('couple_id', coupleId)
          .neq('from_user_id', uid)
          .gt('created_at', s.pokes)
        for (const r of data || []) {
          if (r.kind === 'chat') chat = true
          else pokes++
        }
      }

      // 心情：对方的最新一条 vs 本地快照（值或日期变了 = 有新心情）
      let mood = null
      if (partnerId) {
        const { data } = await supabase
          .from('moods')
          .select('mood, date')
          .eq('user_id', partnerId)
          .order('created_at', { ascending: false })
          .limit(1)
        const row = (data || [])[0] || null
        lastMoodRef.current = row
        if (row) {
          if (!s.moodInit) {
            // 首次见到：静默记快照不提醒（历史状态不算新动态）
            s.mood = { mood: row.mood, date: row.date }
            s.moodInit = true
            persist()
          } else if (!s.mood || s.mood.mood !== row.mood || s.mood.date !== row.date) {
            mood = row
          }
        }
      }

      setCounts({ messages: nMsg + nMsgCmt, diary: nDiaryCmt, chat, pokes, mood })
    } catch {
      /* 查询失败保持现状，下一轮兜底重查 */
    }
  }, [coupleId, user?.id, partner?.user_id, ensureBaseline, persist, stateRef, lastMoodRef])

  refreshRef.current = refresh

  // ---- 常驻兜底：回前台 / 联网恢复 / 每分钟重查，杜绝计数漂移 ----
  // 首次刷新推迟到首屏画完（见文件头注释）：未读不是首屏要显示的内容
  useEffect(() => {
    if (!coupleId || !user) return
    const cancelIdle = whenIdle(() => refresh(), { timeout: 2000, fallback: 400 })
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', refresh)
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, 60000)
    return () => {
      cancelIdle()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', refresh)
      clearInterval(t)
    }
  }, [coupleId, user, refresh])

  // ---- 实时事件：对方有新动作 → 防抖重查（事件风暴合并成一次查询） ----
  useEffect(() => {
    if (!coupleId || !user) return
    const schedule = () => {
      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => refreshRef.current && refreshRef.current(), 600)
    }
    // 共享频道上登记这 5 张表：任意一张有变化 → 防抖重查一次。
    // 心情同一天改值不会产生新行（unique 约束 upsert），所以监听的是「任意事件」，
    // 总线里 moods 也是按 '*' 登记的，改值同样能触发。
    const offs = ['messages', 'message_comments', 'diary_comments', 'pokes', 'moods'].map((table) =>
      subscribeTable(coupleId, table, schedule),
    )
    return () => {
      clearTimeout(debounceRef.current)
      offs.forEach((off) => off())
    }
  }, [coupleId, user])

  // ---- 切页签：进出「留言 / 日记」即视为看完 → 基线吸收 + 计数归零 ----
  // useLayoutEffect：在浏览器画下一帧前完成，避免红点闪一帧
  useLayoutEffect(() => {
    const prev = activeRef.current
    activeRef.current = activeTab
    if (prev === activeTab) return
    ensureBaseline() // 运行中换了空间时，先切到新空间的基线再吸收
    const now = new Date().toISOString()
    const s = stateRef.current.s
    let dirty = false
    const absorb = (...keys) => {
      for (const k of keys) {
        s[k] = now
        dirty = true
      }
    }
    // 进入（开始看）和离开（看完了）都吸收：在页面里收到的新内容不算未读
    if (prev === 'messages' || activeTab === 'messages') absorb('messages', 'pokes')
    if (prev === 'diary' || activeTab === 'diary') absorb('diary')
    if (dirty) persist()
    if (activeTab === 'messages') setCounts((c) => ({ ...c, messages: 0, chat: false, pokes: 0 }))
    if (activeTab === 'diary') setCounts((c) => ({ ...c, diary: 0 }))
    refreshRef.current && refreshRef.current()
  }, [activeTab, persist, ensureBaseline, stateRef])

  // ---- PokeListener 弹过「戳一戳」toast 后广播 → 卡片条目自动清除（用户已看到） ----
  useEffect(() => {
    const onSeen = (e) => {
      if (e.detail === 'pokes') markSeenRef.current('pokes')
    }
    window.addEventListener('unread:seen', onSeen)
    return () => window.removeEventListener('unread:seen', onSeen)
  }, [])

  // ---- 点卡片条目清除（戳一戳 / 心情：没有对应页面可进，点了就是看到了） ----
  const markSeen = useCallback(
    (kind) => {
      ensureBaseline() // 运行中换了空间时，清的是当前空间的
      const s = stateRef.current.s
      if (kind === 'pokes') {
        s.pokes = new Date().toISOString()
        persist()
        setCounts((c) => ({ ...c, pokes: 0, chat: false }))
      } else if (kind === 'mood') {
        if (lastMoodRef.current) {
          s.mood = { mood: lastMoodRef.current.mood, date: lastMoodRef.current.date }
          s.moodInit = true
          persist()
        }
        setCounts((c) => ({ ...c, mood: null }))
      }
    },
    [persist, ensureBaseline, stateRef, lastMoodRef],
  )
  markSeenRef.current = markSeen

  // 渲染派生：正在看的页永远显示 0（内容就在眼前，无需角标）
  const visible = {
    ...counts,
    messages: activeTab === 'messages' ? 0 : counts.messages,
    diary: activeTab === 'diary' ? 0 : counts.diary,
    chat: activeTab === 'messages' ? false : counts.chat,
  }

  const value = {
    counts: visible,
    markSeen,
    refresh,
    tabDots: {
      messages: visible.messages > 0 || visible.chat,
      messagesPulse: visible.chat,
      diary: visible.diary > 0,
    },
  }

  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>
}

// Provider 外（如独立测试/引导页）安全降级：全零 + 空操作
const NULL_UNREAD = {
  counts: { messages: 0, diary: 0, chat: false, pokes: 0, mood: null },
  markSeen: () => {},
  refresh: async () => {},
  tabDots: { messages: false, messagesPulse: false, diary: false },
}

export function useUnread() {
  return useContext(UnreadContext) || NULL_UNREAD
}
