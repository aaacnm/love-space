import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store.jsx'
import { supabase } from '../lib/supabase.js'
import { toast } from '../lib/toast.jsx'
import {
  NOTIFY_DISMISS_KEY,
  flashTitle,
  gotoTab,
  notifyPermission,
  requestNotifyPermission,
  showSystemNotify,
} from '../lib/notify.js'
import { enablePush, healPush } from '../lib/push.js'

function buzz(pattern = [60, 60, 60]) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern)
  } catch {
    /* 部分设备不支持，忽略 */
  }
}

function excerpt(s, n = 26) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

// 对方动了哪张表 → 怎么提醒、点开后去哪个 tab
const RULES = [
  {
    table: 'messages',
    author: 'author_user_id',
    tab: 'messages',
    icon: '💬',
    // 与 push-send 的 buildText 同款四分支：图片 / 语音 / 回复 / 文字
    text: (r) =>
      r.image_path
        ? '给你发来一张图片留言 🖼️'
        : r.voice_path
          ? `给你发来一条语音留言${r.voice_seconds ? `（${r.voice_seconds}″）` : ''}`
          : r.reply_to
            ? `回复了你的留言：${excerpt(r.content)}`
            : `给你留言：${excerpt(r.content)}`,
  },
  { table: 'photos', author: 'author_user_id', tab: 'photos', icon: '📷', text: () => '分享了一张新照片' },
  { table: 'diary_entries', author: 'author_user_id', tab: 'diary', icon: '📝', text: (r) => `写了新日记：${excerpt(r.content)}` },
  { table: 'diary_comments', author: 'author_user_id', tab: 'diary', icon: '💬', text: (r) => `评论了你的日记：${excerpt(r.content)}` },
  { table: 'message_comments', author: 'author_user_id', tab: 'messages', icon: '💬', text: (r) => `回复了留言：${excerpt(r.content)}` },
  { table: 'delete_requests', author: 'requester_user_id', tab: 'photos', icon: '🙋', text: () => '申请删除照片，等你确认' },
  { table: 'period_daily_logs', author: 'user_id', tab: 'period', icon: '🌸', text: () => '更新了生理期打卡' },
]

// ---------- 全局监听：对方的新动态 → 页面横幅 + 系统通知 ----------

export function Notifier() {
  const { coupleId, user, partner } = useStore()
  const [banner, setBanner] = useState(null)
  const [askNotify, setAskNotify] = useState(false)
  const [noNotifyApi, setNoNotifyApi] = useState(false)
  const [deniedTip, setDeniedTip] = useState(false) // 权限被拒：给补救指引而不是沉默
  const bannerTimer = useRef(null)
  const seenRef = useRef(new Set()) // 已提醒过的事件 id：每条只提醒一次

  // SW 系统通知点击 → postMessage → 转发成 app:goto 跳到对应页面
  useEffect(() => {
    if (!navigator.serviceWorker) return
    const onMsg = (e) => {
      if (e.data && e.data.type === 'app:goto' && e.data.tab) {
        window.dispatchEvent(new CustomEvent('app:goto', { detail: e.data.tab }))
      }
    }
    navigator.serviceWorker.addEventListener('message', onMsg)
    return () => navigator.serviceWorker.removeEventListener('message', onMsg)
  }, [])

  // 权限引导：还没问过且没被用户关掉过 → 弹一次；被拒绝过 → 给补救指引
  useEffect(() => {
    if (!user) return
    const check = () => {
      const perm = notifyPermission()
      if (perm === 'unsupported') {
        // iOS 的普通浏览器标签页没有 Notification API，需要先添加到主屏幕
        if (!localStorage.getItem(NOTIFY_DISMISS_KEY)) setNoNotifyApi(true)
        return
      }
      if (perm === 'granted') {
        // 已授权 → 静默自愈：订阅丢了（iOS 会清）就补登记，保证 App 关了也能收到推送
        healPush(user.id)
        return
      }
      if (localStorage.getItem(NOTIFY_DISMISS_KEY)) return
      if (perm === 'denied') setDeniedTip(true)
      else setAskNotify(true)
    }
    check()
    // 手机设置里改完通知权限回到 App 时自动刷新状态
    document.addEventListener('visibilitychange', check)
    return () => document.removeEventListener('visibilitychange', check)
  }, [user])

  // 页面回到前台 / 获得焦点 → 停止标题闪烁
  useEffect(() => {
    const stop = () => flashTitle(false)
    window.addEventListener('focus', stop)
    document.addEventListener('visibilitychange', stop)
    return () => {
      window.removeEventListener('focus', stop)
      document.removeEventListener('visibilitychange', stop)
      flashTitle(false)
    }
  }, [])

  // 一个独立频道监听全部表（自己的频道名，不和 useCollection/Poke 冲突）
  useEffect(() => {
    if (!coupleId || !user) return

    const channel = supabase.channel(`notifier-${coupleId}`)
    for (const rule of RULES) {
      channel.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: rule.table, filter: `couple_id=eq.${coupleId}` },
        (payload) => {
          const row = payload.new
          if (!row || !row.id || seenRef.current.has(row.id)) return
          if (row[rule.author] === user.id) return // 自己的操作不提醒
          seenRef.current.add(row.id)

          const name = partner?.nickname || 'TA'
          const text = rule.text(row)
          buzz()
          flashTitle(true)
          showSystemNotify({ title: `💗 ${name} ${rule.text(row).split('：')[0]}`, body: text, tab: rule.tab })

          // 前台：页面内横幅 5 秒；新事件直接替换当前横幅并重新计时（最新动态优先）
          setBanner({ key: row.id, icon: rule.icon, name, text, tab: rule.tab })
          clearTimeout(bannerTimer.current)
          bannerTimer.current = setTimeout(() => {
            setBanner(null)
            bannerTimer.current = null
          }, 5000)
        },
      )
    }
    channel.subscribe()

    return () => {
      clearTimeout(bannerTimer.current)
      bannerTimer.current = null
      flashTitle(false)
      supabase.removeChannel(channel)
    }
  }, [coupleId, user, partner])

  if (!user) return null

  const openBanner = () => {
    if (banner?.tab) gotoTab(banner.tab)
    setBanner(null)
  }

  return (
    <>
      {/* 对方新动态的横幅（前台 5 秒） */}
      {banner && (
        <div className="pointer-events-none fixed inset-0 z-[61] flex items-start justify-center px-4 pt-6">
          <div className="pointer-events-auto flex w-full max-w-md animate-floatIn items-center gap-3 rounded-card bg-white p-4 shadow-card">
            <span className="text-2xl">{banner.icon}</span>
            <button onClick={openBanner} className="min-w-0 flex-1 text-left">
              <p className="text-sm font-bold text-cocoa">
                {banner.name} {banner.text}
              </p>
              <p className="mt-0.5 text-xs text-rosy">点看看 →</p>
            </button>
            <button
              onClick={() => setBanner(null)}
              className="self-start rounded-full bg-cream px-2.5 py-1 text-xs font-bold text-cocoaSoft"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* 系统通知权限引导 / 被拒后的补救指引（只弹一次，关掉后不再问） */}
      {(askNotify || noNotifyApi || deniedTip) && (
        <div className="pointer-events-none fixed inset-0 z-[62] flex items-start justify-center px-4 pt-6">
          <div className="pointer-events-auto w-full max-w-md animate-floatIn rounded-card bg-white p-5 shadow-card">
            <div className="mb-1 text-center text-4xl">{deniedTip ? '🔕' : '🔔'}</div>
            <p className="text-center font-display text-lg text-cocoa">
              {deniedTip ? '提醒被关掉了' : '开启新消息提醒'}
            </p>
            <p className="mt-1 text-center text-xs text-cocoaSoft">
              {deniedTip
                ? '去手机「设置 → 应用 → 浏览器（或本 App）→ 通知」里允许通知，回到这里点下面的按钮检查'
                : noNotifyApi
                  ? '先在浏览器菜单里「添加到主屏幕」，之后打开 App 就能开启提醒啦'
                  : 'TA 的留言、照片、日记，第一时间知道'}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => {
                  localStorage.setItem(NOTIFY_DISMISS_KEY, '1')
                  setAskNotify(false)
                  setNoNotifyApi(false)
                  setDeniedTip(false)
                }}
                className="flex-1 rounded-full bg-cream py-2.5 text-sm font-bold text-cocoaSoft"
              >
                {deniedTip ? '知道了' : '暂不'}
              </button>
              {!noNotifyApi && (
                <button
                  onClick={async () => {
                    if (deniedTip) {
                      // 权限被拒时再调 requestPermission 不会弹窗，只能等用户改完系统设置后重新检查
                      if (notifyPermission() === 'granted') {
                        localStorage.setItem(NOTIFY_DISMISS_KEY, '1')
                        setDeniedTip(false)
                        buzz()
                        setBanner({ key: 'welcome', icon: '🔔', name: '', text: '提醒已开启，TA 的动态不会再错过啦', tab: null })
                        bannerTimer.current = setTimeout(() => {
                          setBanner(null)
                          bannerTimer.current = null
                        }, 4000)
                      } else {
                        toast.warning('还是「已关闭」状态：请先到手机系统设置里允许通知，再回来点「检查一下」')
                      }
                      return
                    }
                    const res = await requestNotifyPermission()
                    localStorage.setItem(NOTIFY_DISMISS_KEY, '1')
                    setAskNotify(false)
                    if (res === 'granted') {
                      buzz()
                      // 权限到手 → 立刻订阅 Web Push（App 关了也能收）；失败不影响本地提醒
                      enablePush(user.id)
                      setBanner({ key: 'welcome', icon: '🔔', name: '', text: '提醒已开启，TA 的动态不会再错过啦', tab: null })
                      bannerTimer.current = setTimeout(() => {
                        setBanner(null)
                        bannerTimer.current = null
                      }, 4000)
                    }
                  }}
                  className="flex-1 rounded-full bg-blush py-2.5 text-sm font-bold text-white shadow-card transition active:scale-95"
                >
                  {deniedTip ? '检查一下' : '开启'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
