// realtime-lifecycle 测试的渲染入口：最小 harness，
// 通过 window.__setActive / __setEnabled 在测试里驱动 TabActiveContext 与 enabled
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useCollection, TabActiveContext } from '../../src/lib/hooks.js'

function Probe({ enabled }) {
  const { rows, loading } = useCollection('photos', 'c1', { enabled })
  return <div id="probe">{rows.length}:{String(loading)}</div>
}

function App() {
  const [active, setActive] = useState(true)
  const [enabled, setEnabled] = useState(true)
  window.__setActive = setActive
  window.__setEnabled = setEnabled
  return (
    <TabActiveContext.Provider value={active}>
      <Probe enabled={enabled} />
    </TabActiveContext.Provider>
  )
}

createRoot(document.getElementById('root')).render(<App />)
