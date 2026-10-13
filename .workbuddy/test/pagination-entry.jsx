// realtime-pagination 测试的渲染入口：
// Probe 暴露 usePagedCollection 的控制句柄与状态；LM 系列测 LoadMore 组件渲染
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { usePagedCollection, TabActiveContext } from '../../src/lib/hooks.js'
import LoadMore from '../../src/components/LoadMore.jsx'

function Probe() {
  const { rows, loading, loadingMore, hasMore, reload, loadMore } = usePagedCollection('photos', 'c1')
  window.__probe = { reload, loadMore, rows, loading, loadingMore, hasMore }
  return <div id="probe">{rows.length}:{String(hasMore)}</div>
}

function LM() {
  const [calls, setCalls] = useState(0)
  window.__lmCalls = calls
  return <LoadMore hasMore={true} loading={false} onLoadMore={() => setCalls((c) => c + 1)} />
}

function LMEnd() {
  return <div id="lm-end"><LoadMore hasMore={false} loading={false} onLoadMore={() => {}} /></div>
}

function LMEmpty() {
  return <div id="lm-empty"><LoadMore hasMore={true} loading={false} onLoadMore={() => {}} empty={true} /></div>
}

function App() {
  const [active, setActive] = useState(true)
  window.__setActive = setActive
  return (
    <TabActiveContext.Provider value={active}>
      <Probe />
      <LM />
      <LMEnd />
      <LMEmpty />
    </TabActiveContext.Provider>
  )
}

createRoot(document.getElementById('root')).render(<App />)
