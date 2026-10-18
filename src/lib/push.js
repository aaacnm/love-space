// Web Push 订阅管理 —— 「App 完全关闭也能收到通知」的关键
//
// 与页面内通知（notify.js）的分工：
//   notify.js：App 活着时，实时监听 → 本地弹通知（前台横幅同源）
//   push.js  ：把「这个浏览器的推送地址」登记到 push_subscriptions 表，
//              服务器（Edge Function）就能在 App 死了时主动推过来
//
// iOS 硬性要求（16.4+）：必须先「添加到主屏幕」成为 PWA，普通浏览器标签页
// 没有 PushManager——这正是 Notifier 里 noNotifyApi 提示「先添加到主屏幕」的原因。
import { supabase } from './supabase.js'

// VAPID 公钥（与 push-send 里的私钥成对）
// ⚠ 公钥本来就可以公开（浏览器拿它订阅），**私钥绝不能进仓库** ——
//   它现在只存在于 Edge Function 的环境变量（Supabase Secrets）里，见 PUSH_SETUP.md。
//   2026-10-17 轮换过一次：旧的订阅会失效，App 里重新点「开启提醒」即可。
const VAPID_PUBLIC_KEY = 'BGenotm3QSHOv-cNSAyioIe_jVKUCeuBPH8KuYzF9tlkTmL2QT-nfNbHbBbp3caO4i0HWlmW1qyC0aErgI7XlHo'

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

async function getRegistration() {
  if (!('serviceWorker' in navigator)) return null
  return (
    (await navigator.serviceWorker.getRegistration().catch(() => null)) ||
    (await navigator.serviceWorker.register('/sw.js').catch(() => null))
  )
}

// 订阅状态：unsupported | denied | subscribed | unsubscribed
export async function pushState() {
  if (!pushSupported()) return 'unsupported'
  if (window.Notification.permission === 'denied') return 'denied'
  const reg = await getRegistration()
  if (!reg) return 'unsubscribed'
  const sub = await reg.pushManager.getSubscription().catch(() => null)
  return sub ? 'subscribed' : 'unsubscribed'
}

async function upsertSubscription(sub, userId) {
  const json = sub.toJSON()
  if (!json.endpoint || !json.keys || !json.keys.p256dh || !json.keys.auth) return false
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: userId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      user_agent: navigator.userAgent,
    },
    { onConflict: 'endpoint' },
  )
  return !error
}

// 开启推送：申请权限（会弹系统授权框）→ 订阅 → 登记入库
// 已授权时调用不弹框，静默补订阅（自愈路径复用它）
export async function enablePush(userId) {
  if (!pushSupported()) return { ok: false, state: 'unsupported' }
  let perm = window.Notification.permission
  if (perm === 'default') {
    try {
      perm = await window.Notification.requestPermission()
    } catch {
      perm = 'denied'
    }
  }
  if (perm !== 'granted') return { ok: false, state: perm === 'denied' ? 'denied' : 'default' }

  const reg = await getRegistration()
  if (!reg) return { ok: false, state: 'no-sw' }
  let sub = await reg.pushManager.getSubscription().catch(() => null)
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      })
    } catch {
      return { ok: false, state: 'subscribe-failed' }
    }
  }
  const ok = await upsertSubscription(sub, userId)
  return { ok, state: 'subscribed', sub }
}

// 自愈：iOS 会静默丢弃长期未用的订阅。已授权的用户每次进 App 都补登记一次
// （不弹框、不打扰；订阅还在就刷新 updated_at）
export async function healPush(userId) {
  try {
    if (!pushSupported() || !userId) return
    if (window.Notification.permission !== 'granted') return
    const reg = await getRegistration()
    if (!reg) return
    const sub = await reg.pushManager.getSubscription().catch(() => null)
    if (sub) await upsertSubscription(sub, userId)
  } catch {
    /* 静默失败，不影响主流程 */
  }
}

// 关闭推送：退订 + 删除登记
export async function disablePush(userId) {
  try {
    const reg = await getRegistration()
    const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null
    if (sub) await sub.unsubscribe()
    if (userId) await supabase.from('push_subscriptions').delete().eq('user_id', userId)
  } catch {
    /* ignore */
  }
}
