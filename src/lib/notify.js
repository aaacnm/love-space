// 系统通知的统一入口：权限申请 + 弹通知（App 在后台时用，前台走页面内横幅）
export const NOTIFY_DISMISS_KEY = 'notify_prompt_dismissed'

export function notifySupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function notifyPermission() {
  if (!notifySupported()) return 'unsupported'
  return window.Notification.permission // 'default' | 'granted' | 'denied'
}

// 返回 'granted' | 'denied' | 'default' | 'unsupported'
export async function requestNotifyPermission() {
  if (!notifySupported()) return 'unsupported'
  try {
    return await window.Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

// 弹一条系统通知（未授权或前台可见时不弹，避免和页面横幅双重打扰）
// 优先走 Service Worker 的 showNotification：手机上通知栏显示更稳定，
// 点击由 SW 的 notificationclick 唤回 App 并跳转（页面级通知在后台常无法唤醒）。
export async function showSystemNotify({ title, body, tab }) {
  try {
    if (!notifySupported() || window.Notification.permission !== 'granted') return
    if (!document.hidden) return
    const payload = {
      body,
      tag: 'love-' + (tab || 'home'),
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { tab: tab || null },
    }
    try {
      const reg = (navigator.serviceWorker && (await navigator.serviceWorker.getRegistration())) || null
      if (reg) {
        await reg.showNotification(title, payload)
        return
      }
    } catch {
      /* SW 通道不可用则降级为页面通知 */
    }
    const n = new window.Notification(title, { body: payload.body, tag: payload.tag, icon: payload.icon })
    n.onclick = () => {
      try {
        window.focus()
        window.dispatchEvent(new CustomEvent('app:goto', { detail: tab }))
      } catch {
        /* ignore */
      }
      n.close()
    }
  } catch {
    /* 部分环境（如未安装到主屏幕的 iOS）不支持，忽略 */
  }
}

// 标题栏闪烁提醒：有未读时把标签页/App 标题换成「💗 有新消息」
const ORIG_TITLE = typeof document !== 'undefined' ? document.title : ''
let titleTimer = null

export function flashTitle(on) {
  if (typeof document === 'undefined') return
  if (on) {
    if (titleTimer) return
    let flip = false
    titleTimer = setInterval(() => {
      document.title = flip ? '💗 有新消息' : ORIG_TITLE
      flip = !flip
    }, 1200)
  } else {
    clearInterval(titleTimer)
    titleTimer = null
    document.title = ORIG_TITLE
  }
}

// 触发页面跳转到某个 tab（Dashboard 监听 app:goto 事件）
export function gotoTab(tab) {
  window.dispatchEvent(new CustomEvent('app:goto', { detail: tab }))
}
