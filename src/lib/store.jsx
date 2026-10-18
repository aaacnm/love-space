import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { toast } from './toast.jsx'
import {
  ensureAnonymousUser,
  fetchBootstrap,
  fetchCouple,
  fetchMembers,
  fetchMilestones,
  fetchMyMember,
  localSessionUserId,
  localToday,
  restoreSession,
  signInAnonymous,
  verifyUser,
} from './couple.js'
import { subscribeTable } from './realtimeBus.js'
import { clearAllRows } from './collectionCache.js'

const StoreContext = createContext(null)

// 上一次打开时存下来的「空间基础信息」。
// 用途只有一个：**先把页面画出来**，省掉首屏那几段往返。
// 它不决定任何人能看到什么——真正的数据权限仍由 Supabase RLS 在后台请求里判定，
// 后台拿不到的数据会覆盖掉这里的缓存（拿不到就是没权限，页面回到该去的地方）。
//
// ⚠ 它的隐患：这份缓存属于**某一个**用户，共用设备清掉登录状态、或换成另一个账号之后，
//   它还躺在 localStorage 里。以前首帧无条件 adopt，旧的成员资料 / 情侣码 / 列表缓存
//   会先画给下一个使用者看，几百毫秒到几秒后才被后台请求覆盖。
//   所以 adopt 有一条硬前提：**必须先确认本机会话身份就是缓存的主人**（见 StoreProvider）。
const CACHE_KEY = 'love.space.v1'

function readCache() {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw)
    if (!c?.coupleId || !c?.userId) return null
    return c
  } catch {
    return null // 缓存坏了就当没缓存，走正常加载（不能让坏数据把首屏卡死）
  }
}

function writeCache(c) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ ...c, v: 1, savedAt: Date.now() }))
  } catch {
    /* 隐私模式 / 配额满：缓存写不进去不影响使用 */
  }
}

function clearCache() {
  try {
    window.localStorage.removeItem(CACHE_KEY)
  } catch {
    /* noop */
  }
}

// 「纪念日 / 下次见面」的本地兜底算法。优先用服务端在 bootstrap 里算好的结果，
// 只有在 RPC 不可用（迁移没跑）时才自己算一遍，两边规则保持一致。
function pickDerived(milestones) {
  const list = milestones || []
  const today = localToday()
  const anniversary =
    list.filter((m) => m.type === 'anniversary').sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] || null
  const nextMeetup =
    list
      .filter((m) => m.type === 'meetup' && String(m.date).slice(0, 10) >= today)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] || null
  return { anniversary, nextMeetup }
}

export function StoreProvider({ children }) {
  // 一次读盘 + 一次认领判断，都必须在**首次渲染内**完成（useEffect 要等这一帧画完才跑，
  // 那时判断就晚了 —— 屏幕已经把缓存画出来了）。
  //   disk    ：磁盘上那份缓存（可能属于别人）
  //   claimed ：能确认为「本机当前身份」的那份才认领认领，否则什么都不 adopt
  const [initial] = useState(() => {
    const disk = readCache()
    if (!disk) return { disk: null, claimed: null }
    const who = localSessionUserId()
    // 认领不了就先不渲染任何身份相关的内容（掉回启动画面），由异步流程接手处理
    return { disk, claimed: who === disk.userId ? disk : null }
  })
  const claimed = initial.claimed
  const [user, setUser] = useState(claimed?.user || null)
  const [coupleId, setCoupleId] = useState(claimed?.coupleId || null)
  const [couple, setCouple] = useState(claimed?.couple || null)
  const [members, setMembers] = useState(claimed?.members || [])
  const [milestones, setMilestones] = useState(claimed?.milestones || [])
  const [derived, setDerived] = useState(claimed?.derived || null)
  // 有已认领的缓存 = 首屏已经有东西可画，不进入「加载中」状态
  const [loading, setLoading] = useState(!claimed)

  const dropCache = useCallback(() => {
    clearCache()
    setCoupleId(null)
    setCouple(null)
    setMembers([])
    setMilestones([])
    setDerived(null)
  }, [])

  // 认不出主人的缓存（会话被清掉 / 换了账号）→ 空间缓存和列表缓存一起销毁。
  // 列表缓存里存的是真实的留言、日记正文，比空间基础信息更私密，不能跟着一起留下。
  const discardForeignCache = useCallback(() => {
    clearAllRows()
    dropCache()
  }, [dropCache])

  // 把一次拿到的结果落到 state + 缓存；couple 为 null（不在任何空间）则清掉缓存
  const applyBootstrap = useCallback((data, u) => {
    const c = data?.couple || null
    const ms = data?.milestones || []
    const d =
      data?.anniversary || data?.nextMeetup
        ? { anniversary: data?.anniversary || null, nextMeetup: data?.nextMeetup || null }
        : pickDerived(ms)
    setCouple(c)
    setMembers(data?.members || [])
    setMilestones(ms)
    setDerived(d)
    setCoupleId(c?.id || null)
    const who = data?.user || u || null
    if (c && who?.id) {
      writeCache({
        userId: who.id,
        user: who,
        coupleId: c.id,
        couple: c,
        members: data?.members || [],
        milestones: ms,
        derived: d,
      })
    } else {
      clearCache()
    }
  }, [])

  // 一次拿齐（首选路径）。返回 false = RPC 不可用，让调用方回退
  const bootstrap = useCallback(
    async (u) => {
      try {
        const data = await fetchBootstrap()
        applyBootstrap(data, u)
        if (data?.user) setUser(data.user)
        return true
      } catch {
        return false
      }
    },
    [applyBootstrap],
  )

  // 回退路径：RPC 不存在（033 还没跑）时走原来的多请求查法
  const loadLegacy = useCallback(
    async (u) => {
      const member = await fetchMyMember(u.id)
      if (!member) {
        dropCache()
        return
      }
      const [c, m, ms] = await Promise.all([
        fetchCouple(member.couple_id),
        fetchMembers(member.couple_id),
        fetchMilestones(member.couple_id),
      ])
      applyBootstrap({ user: u, couple: c, members: m || [], milestones: ms || [] }, u)
    },
    [applyBootstrap, dropCache],
  )

  const pull = useCallback(
    async (u) => {
      const ok = await bootstrap(u)
      if (!ok) await loadLegacy(u)
    },
    [bootstrap, loadLegacy],
  )

  // 首次进入：本地会话 → 一次拿齐 → 后台校验身份
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // 1) 先读本地会话（不发网络请求），有就直接用来取数据
        const cachedUser = await restoreSession()
        if (cancelled) return
        // 首帧没能认领那份磁盘缓存的情况在这里收口：
        //   · 本地没有会话 → 设备当前不属于任何已知身份，缓存一律不可信（共用设备刚清过登录态）
        //   · 会话换了人     → 缓存是上一个主人留下的
        // 两种都必须**先销毁再取身份**，否则匿名登录前那段空窗会把旧空间画出来。
        if (!cachedUser) discardForeignCache()
        else if (initial.disk && initial.disk.userId !== cachedUser.id) discardForeignCache()
        // 冷启动（确认没有会话）直接匿名登录：restoreSession 已经判定本机没有可用会话，
        // 再去 getUser() 探一遍纯属多等一个 RTT
        const u = cachedUser || (await signInAnonymous())
        if (cancelled) return
        setUser(u)
        await pull(u)
        if (cancelled) return

        // 2) 后台联网校验（能刷新过期 token）：失败就重新拿身份再拉一次。
        //    此时页面早已画出来，用户不会看到转圈。
        const verified = await verifyUser()
        if (cancelled || verified) return
        const u2 = await ensureAnonymousUser()
        if (cancelled) return
        setUser(u2)
        await pull(u2)
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
    // initial 是只读的首帧快照，不需要进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pull])

  // 手动 / 实时刷新：同样优先走一次拿齐，RPC 不可用时回退
  const refresh = useCallback(async () => {
    const u = user || (await restoreSession())
    if (!u) return
    try {
      const ok = await bootstrap(u)
      if (!ok) throw new Error('bootstrap unavailable')
    } catch {
      if (!coupleId) return
      const [m, ms] = await Promise.all([fetchMembers(coupleId), fetchMilestones(coupleId)])
      setMembers(m || [])
      setMilestones(ms || [])
      setDerived(pickDerived(ms))
      // 若当前用户已被移出空间，回到引导页
      if (user && !m?.some((x) => x.user_id === user.id)) {
        dropCache()
      }
    }
  }, [user, coupleId, bootstrap, dropCache])

  // 成员 / 纪念日 变动时实时刷新（例如对方加入空间、改时间）
  // 挂在 space-<coupleId> 共享频道上：全 App 对一个空间只有一个 Realtime 频道
  useEffect(() => {
    if (!coupleId) return
    const offs = ['members', 'milestones'].map((table) => subscribeTable(coupleId, table, refresh))
    return () => {
      offs.forEach((off) => off())
    }
  }, [coupleId, refresh])

  const enterSpace = useCallback(
    async (cid) => {
      const u = user || (await restoreSession())
      if (!u) return
      const [c, m, ms] = await Promise.all([fetchCouple(cid), fetchMembers(cid), fetchMilestones(cid)])
      applyBootstrap({ user: u, couple: c, members: m || [], milestones: ms || [] }, u)
    },
    [user, applyBootstrap],
  )

  // 退出空间：清空空间相关状态与缓存，回到引导页
  const leaveSpace = useCallback(() => {
    dropCache()
  }, [dropCache])

  const value = {
    user,
    coupleId,
    couple,
    members,
    milestones,
    derived,
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
