import { lazy, Suspense, useEffect, useState } from 'react'
import TabBar from '../components/TabBar.jsx'
import { PokeListener } from '../components/Poke.jsx'
import { Notifier } from '../components/Notifier.jsx'
import { UnreadProvider } from '../lib/unread.jsx'
import { useStore } from '../lib/store.jsx'
import { TabActiveContext } from '../lib/hooks.js'
import { applyGenderTheme } from '../lib/theme.js'
import Home from './Home.jsx'

// 页面级代码分包：首屏只带首页的代码，其余 5 个页签各成独立分包。
// 空闲时预热（见下方 effect），预热完成前点页签由 Suspense 兜底显示加载态。
// 页签保活逻辑不变：访问过就常驻（display:none 隐藏），分包代码只加载一次。
const Diary = lazy(() => import('./Diary.jsx'))
const Photos = lazy(() => import('./Photos.jsx'))
const Peace = lazy(() => import('./Peace.jsx'))
const Messages = lazy(() => import('./Messages.jsx'))
const Period = lazy(() => import('./Period.jsx'))

const VIEWS = {
  home: Home,
  diary: Diary,
  photos: Photos,
  peace: Peace,
  messages: Messages,
  period: Period,
}

// 分包加载中的兜底占位（正常情况下预热先行，用户很难看到它）
function TabFallback() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-20">
      <span className="animate-pulse text-3xl">💗</span>
      <span className="text-sm font-bold text-cocoaSoft/60">加载中…</span>
    </div>
  )
}

export default function Dashboard() {
  const { myMember } = useStore()
  const [tab, setTab] = useState('home')
  // 男生账号 → 蓝调主题（html.theme-male，CSS 变量整体换色）；女生/未设置 → 默认粉调
  useEffect(() => {
    applyGenderTheme(myMember?.gender)
  }, [myMember?.gender])
  // 卸载时还原默认，避免登录态切换后残留旧主题
  useEffect(() => () => applyGenderTheme(null), [])
  // 空闲时预热其余页签的分包：首屏渲染完、浏览器有空闲再拉代码，
  // 不与首屏关键资源抢带宽；预热完成后点页签零等待
  useEffect(() => {
    const warm = () => {
      import('./Diary.jsx')
      import('./Photos.jsx')
      import('./Peace.jsx')
      import('./Messages.jsx')
      import('./Period.jsx')
    }
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(warm, { timeout: 5000 })
      return () => window.cancelIdleCallback && window.cancelIdleCallback(id)
    }
    const t = setTimeout(warm, 2500)
    return () => clearTimeout(t)
  }, [])
  // 访问过的 tab 保持挂载，切走只是 display:none：
  // 手机上切 tab 秒回（不用重新拉数据/重建几十张图片的 DOM）。
  // 资源不会无限堆积：TabActiveContext 把「当前是否可见」传给 useCollection，
  // 隐藏 tab 的 Realtime 订阅、visibilitychange/online 监听会被暂停移除，
  // 切回时自动重新订阅并补拉一次数据（DOM 与已拉取数据仍保留，秒回体验不变）。
  const [visited, setVisited] = useState(['home'])
  if (!visited.includes(tab)) setVisited([...visited, tab]) // 渲染期登记，无空白帧

  // 全局跳转：通知横幅 / 系统通知点击后切到对应页面（app:goto 事件）
  useEffect(() => {
    const handler = (e) => {
      if (e.detail) setTab(e.detail)
    }
    window.addEventListener('app:goto', handler)
    return () => window.removeEventListener('app:goto', handler)
  }, [])

  // （手机切后台再回来的数据补拉：useCollection 自带 visibilitychange 监听；
  //  隐藏 tab 的监听已随 TabActiveContext 暂停，只有当前 tab 会补拉，一次切前台
  //  不再触发所有常驻页面的查询风暴）

  return (
    // UnreadProvider：统一未读中心。当前页签传进去，Provider 在进出
    // 「留言 / 日记」时自动吸收基线（未读清除），红点在 TabBar / 首页卡片共享
    <UnreadProvider activeTab={tab}>
      {/* flex-col + flex-1：内容不足一屏时导航条仍贴在屏幕底部；
          TabBar 用 sticky 占据文档末尾的真实位置，不再需要给内容留 pb-24 防遮挡 */}
      <div className="bg-paper flex min-h-screen flex-col">
        <main className="mx-auto w-full max-w-md flex-1 px-4 pt-6">
          {visited.map((k) => {
            const View = VIEWS[k]
            return (
              <div key={k} className={tab === k ? '' : 'hidden'} aria-hidden={tab !== k}>
                {/* 可见性只传给 tab 内容：TabBar/Notifier/PokeListener 在外层，始终活跃 */}
                <TabActiveContext.Provider value={tab === k}>
                  <Suspense fallback={<TabFallback />}>
                    <View />
                  </Suspense>
                </TabActiveContext.Provider>
              </div>
            )
          })}
        </main>
        <TabBar active={tab} onChange={setTab} />
        <PokeListener />
        <Notifier />
      </div>
    </UnreadProvider>
  )
}
