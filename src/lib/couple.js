import { supabase } from './supabase.js'

// 本地时区的今天（'YYYY-MM-DD'）。别用 toISOString()：它按 UTC 算，
// 东八区在早上 8 点前会算成昨天，「下次见面」就会多出一天。
export function localToday() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 从本地存储恢复会话：**不发网络请求**（Supabase 把 session 存在 localStorage，
// token 快过期时才会在内部静默刷新）。首屏因此可以先画出来再慢慢校验。
export async function restoreSession() {
  if (typeof supabase.auth.getSession !== 'function') return null
  const { data } = await supabase.auth.getSession()
  return data?.session?.user || null
}

// 联网校验会话（比 getSession 权威，能刷新过期 token）：放在后台跑，不挡首屏
export async function verifyUser() {
  const { data } = await supabase.auth.getUser()
  return data?.user || null
}

// 首屏一次拿齐：用户 / 空间 / 我的成员 / 成员列表 / 里程碑 /
// 服务端算好的「纪念日」「下次见面」。原来是 3 段串行请求，合成 1 段。
export async function fetchBootstrap() {
  const { data, error } = await supabase.rpc('bootstrap_space', { p_today: localToday() })
  if (error) throw error
  // PostgREST 返回的是单个 json；个别版本/stub 可能给数组，统一一下
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null
  return {
    user: row.user || null,
    couple: row.couple || null,
    myMember: row.my_member || null,
    members: row.members || [],
    milestones: row.milestones || [],
    anniversary: row.anniversary || null,
    nextMeetup: row.next_meetup || null,
  }
}

// 同步读出「本地会话里的用户 id」：不联网、不校验签名、不刷新 token。
// 它只为一件事服务 —— 判断磁盘上那份空间缓存（love.space.v1）属不属于**现在这台设备上的我**。
//
// 为什么必须是同步的：store 认领缓存发生在 useState 初始化里（首次渲染期间），
// 而 useEffect 要等那一帧画完才跑。等到 effect 里再判断，旧的成员资料、情侣码、
// 列表缓存就已经画在屏幕上了 —— 共用设备清过登录状态或换过账号，那就是一次真实的泄露。
//
// supabase-js v2 默认把 session 存在 localStorage 的 `sb-<projectRef>-auth-token` 里，
// ref 就是项目 URL 的首段主机名。读不到 / 结构变了 / 隐私模式 → 返回 null，
// 调用方一律按「这份缓存不是当前身份的」处理（兜底方向永远是保守的）。
export function localSessionUserId() {
  try {
    const ls = window.localStorage
    if (!ls) return null
    // 候选：主 key，以及 auth-js 在启用 userStorage 时单独存的 `<key>-user`（{"user":{…}}）
    const candidates = []
    const ref = projectRef()
    if (ref) candidates.push(`sb-${ref}-auth-token`)
    for (let i = 0; i < ls.length; i += 1) {
      const k = ls.key(i)
      if (k && /^sb-.+-auth-token(-user)?$/.test(k) && !candidates.includes(k)) candidates.push(k)
    }
    // 主 key 优先：它带 user 时一条就够；没有再试 -user 那份
    const ordered = [...candidates, ...candidates.map((k) => `${k}-user`)]
    for (const k of ordered) {
      const id = parseUserId(ls.getItem(k))
      if (id) return id
    }
    return null
  } catch {
    return null
  }
}

function parseUserId(raw) {
  try {
    const id = JSON.parse(raw || 'null')?.user?.id
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

function projectRef() {
  try {
    const host = new URL(String(import.meta.env?.VITE_SUPABASE_URL || '')).hostname
    return host.split('.')[0] || ''
  } catch {
    return ''
  }
}

// 匿名登录：每个设备/浏览器获得一个稳定身份，无需邮箱。
// 会先联网 getUser() 探一次，适合「不确定有没有会话」的场景。
export async function ensureAnonymousUser() {
  const { data } = await supabase.auth.getUser()
  if (data?.user) return data.user
  return signInAnonymous()
}

// 冷启动专用：调用方**已经确认本地没有会话**（getSession 返回空）时直接匿名登录。
// 前面那次 getSession 已经判定这台设备当前没有任何可用会话，再联网 getUser() 探一遍
// 结果必然也是「没有」，等于白等一个 RTT —— 冷启动最贵的就是这段往返。
export async function signInAnonymous() {
  const { data, error } = await supabase.auth.signInAnonymously()
  if (error) throw error
  return data.user
}

// 查询当前用户所属空间（按 user_id 精确过滤，避免多成员时 maybeSingle 报错）
export async function fetchMyMember(userId) {
  const { data, error } = await supabase
    .from('members')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data
}

// 创建空间
export async function createCouple({ nickname, emoji, city, timezone, anniversaryDate }) {
  const { data, error } = await supabase.rpc('create_couple', {
    p_my_nickname: nickname,
    p_my_emoji: emoji,
    p_my_city: city || null,
    p_my_timezone: timezone || null,
    p_anniversary_date: anniversaryDate || null,
  })
  if (error) throw error
  return data
}

// 加入空间
export async function joinCouple({ code, nickname, emoji, city, timezone }) {
  const { data, error } = await supabase.rpc('join_couple', {
    p_code: code,
    p_nickname: nickname,
    p_emoji: emoji,
    p_city: city || null,
    p_timezone: timezone || null,
  })
  if (error) throw error
  return data
}

// 读取情侣空间基本信息（含情侣码）
export async function fetchCouple(coupleId) {
  const { data, error } = await supabase.from('couples').select('*').eq('id', coupleId).maybeSingle()
  if (error) throw error
  return data
}

// 读取空间成员
export async function fetchMembers(coupleId) {
  const { data, error } = await supabase
    .from('members')
    .select('*')
    .eq('couple_id', coupleId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}

// 读取纪念日/见面节点
export async function fetchMilestones(coupleId) {
  const { data, error } = await supabase
    .from('milestones')
    .select('*')
    .eq('couple_id', coupleId)
    .order('date', { ascending: true })
  if (error) throw error
  return data
}

// 更新自己的资料
export async function updateMyProfile({ nickname, emoji, city, timezone, avatar_path, gender }) {
  const { data: user } = await supabase.auth.getUser()
  if (!user?.user) return
  const update = { nickname, emoji, city, timezone }
  if (avatar_path !== undefined) update.avatar_path = avatar_path // 允许置 null（恢复 emoji 头像）
  if (gender !== undefined) update.gender = gender // 'male' | 'female' | null（清除）
  const { error } = await supabase
    .from('members')
    .update(update)
    .eq('user_id', user.user.id)
  if (error) throw error
}

// 主动退出空间：只删除自己的成员记录，空间与所有内容保留，情侣码仍可重新加入
export async function leaveCouple() {
  const { data: u } = await supabase.auth.getUser()
  if (!u?.user) return
  const { error } = await supabase
    .from('members')
    .delete()
    .eq('user_id', u.user.id)
  if (error) throw error
}
