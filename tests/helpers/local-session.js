/**
 * 本机会话的测试替身。
 *
 * store 现在有一条硬前提：**必须先确认本机会话身份，才允许渲染空间缓存**
 * （共用设备清过登录态 / 换过账号时，旧空间不能再露出来）。它是在 useState 初始化里
 * 同步判断的，读的就是 supabase-js 存会话的那个 key（`sb-<ref>-auth-token`，
 * 形如 `{"user":{"id":"u1"},…}`）。
 *
 * 因此渲染真页面的用例，除了写 love.space.v1，还**必须**把会话也写进 localStorage ——
 * 只写空间缓存的话，store 认不出缓存的主人，一个字段都不会 adopt。
 */
export const SESSION_KEY = 'sb-love-test-auth-token'

export function writeLocalSession(userId) {
  if (userId == null) {
    window.localStorage.removeItem(SESSION_KEY)
    return
  }
  window.localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ access_token: 'local', expires_at: Date.now() + 3600_000, user: { id: userId } }),
  )
}
