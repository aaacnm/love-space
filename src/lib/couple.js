import { supabase } from './supabase.js'

// 匿名登录：每个设备/浏览器获得一个稳定身份，无需邮箱
export async function ensureAnonymousUser() {
  // 先尝试恢复并校验已有会话（getUser 联网校验 + 自动刷新过期 token）
  const { data } = await supabase.auth.getUser()
  if (data?.user) return data.user

  const { data: signIn, error } = await supabase.auth.signInAnonymously()
  if (error) throw error
  return signIn.user
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
