import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { toast } from './toast.jsx'
import {
  ensureAnonymousUser,
  fetchMyMember,
  fetchCouple,
  fetchMembers,
  fetchMilestones,
} from './couple.js'
import { supabase } from './supabase.js'

const StoreContext = createContext(null)

export function StoreProvider({ children }) {
  const [user, setUser] = useState(null)
  const [coupleId, setCoupleId] = useState(null)
  const [couple, setCouple] = useState(null)
  const [members, setMembers] = useState([])
  const [milestones, setMilestones] = useState([])
  const [loading, setLoading] = useState(true)

  const loadSpace = useCallback(async (cid) => {
    const [c, m, ms] = await Promise.all([
      fetchCouple(cid),
      fetchMembers(cid),
      fetchMilestones(cid),
    ])
    setCouple(c)
    setMembers(m || [])
    setMilestones(ms || [])
    setCoupleId(cid)
  }, [])

  // 首次进入：匿名登录 -> 找所属空间
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const u = await ensureAnonymousUser()
        if (cancelled) return
        setUser(u)
        const member = await fetchMyMember(u.id)
        if (cancelled) return
        if (member) await loadSpace(member.couple_id)
      } catch (e) {
        console.error('初始化失败', e)
        // 这里失败 = 页面拿不到空间数据，用户必须知道（否则只会一直转圈）
        toast.error('加载失败：' + (e?.message || '未知错误') + '\n请刷新页面重试')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadSpace])

  const refresh = useCallback(async () => {
    if (!coupleId) return
    const [m, ms] = await Promise.all([fetchMembers(coupleId), fetchMilestones(coupleId)])
    setMembers(m || [])
    setMilestones(ms || [])
    // 若当前用户已被移出空间，回到引导页
    if (user && !m?.some((x) => x.user_id === user.id)) {
      setCoupleId(null)
      setCouple(null)
    }
  }, [coupleId, user])

  // 成员 / 纪念日 变动时实时刷新（例如对方加入空间、改时间）
  useEffect(() => {
    if (!coupleId) return
    const channel = supabase
      .channel(`space-state-${coupleId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'members', filter: `couple_id=eq.${coupleId}` },
        refresh,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'milestones', filter: `couple_id=eq.${coupleId}` },
        refresh,
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [coupleId, refresh])

  const enterSpace = useCallback(
    async (cid) => {
      await loadSpace(cid)
    },
    [loadSpace],
  )

  // 退出空间：清空空间相关状态，回到引导页
  const leaveSpace = useCallback(() => {
    setCoupleId(null)
    setCouple(null)
    setMembers([])
    setMilestones([])
  }, [])

  const value = {
    user,
    coupleId,
    couple,
    members,
    milestones,
    loading,
    refresh,
    enterSpace,
    leaveSpace,
    myMember: members.find((m) => m.user_id === user?.id) || null,
    partner: members.find((m) => m.user_id !== user?.id) || null,
  }

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
