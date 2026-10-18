import { StoreProvider, useStore } from './lib/store.jsx'
import { Spinner } from './components/ui.jsx'
import Onboarding from './views/Onboarding.jsx'
import Dashboard from './views/Dashboard.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { ToastProvider } from './lib/toast.jsx'

// 首次打开（本地既没有会话缓存也没有空间缓存）才会看到它。
// 有缓存时 store 首帧就把空间数据准备好了，直接进首页、后台再刷新，不再干等网络。
function BootSplash() {
  return (
    <div className="bg-paper flex min-h-screen items-center justify-center">
      <div className="text-center">
        <div className="mb-3 animate-bounce text-6xl">💕</div>
        <Spinner label="正在打开你们的手账…" />
      </div>
    </div>
  )
}

function Root() {
  const { coupleId, loading } = useStore()

  // loading 且连缓存都没有 → 真在等网络，给个启动画面；
  // 只要已经知道自己在哪个空间（哪怕数据还是缓存里的旧值），就把页面先画出来
  if (loading && !coupleId) return <BootSplash />

  if (!coupleId) return <Onboarding />

  return <Dashboard />
}

export default function App() {
  return (
    <StoreProvider>
      {/* ToastProvider：全站统一提示的挂载点（成功/失败/警告/进行中） */}
      <ToastProvider>
        <ErrorBoundary>
          <Root />
        </ErrorBoundary>
      </ToastProvider>
    </StoreProvider>
  )
}
