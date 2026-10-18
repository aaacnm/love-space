// 把「不着急」的活推到首屏画完之后：等浏览器画完这一帧、主线程空下来再跑。
//
// 首页以前一进来就发七八条 SQL（未读统计、通知、戳一戳历史、心情全表…），
// 其中真正要显示的东西只有「今天的心情」和「最近一条戳」。剩下那些（红点角标、
// 首页卡片提醒）晚几百毫秒补上用户完全无感，却能让首屏少一半请求。
//
// 用法：const cancel = whenIdle(fn)；effect 清理里调用 cancel()。
export function whenIdle(fn, { timeout = 2000, fallback = 400 } = {}) {
  if (typeof fn !== 'function') return () => {}
  let idleId = null
  let timer = null
  let cancelled = false
  const run = () => {
    if (cancelled) return
    cancelled = true
    fn()
  }
  const hasIdle =
    typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function'
  if (hasIdle) idleId = window.requestIdleCallback(run, { timeout })
  else timer = setTimeout(run, fallback)

  return () => {
    cancelled = true
    if (idleId != null && hasIdle && window.cancelIdleCallback) window.cancelIdleCallback(idleId)
    if (timer != null) clearTimeout(timer)
  }
}
