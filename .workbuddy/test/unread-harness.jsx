// unread 测试挂载骨架：Provider + 探针 + 首页卡片 + 底部导航
import { UnreadProvider, useUnread } from '../../src/lib/unread.jsx'
import PartnerNews from '../../src/components/PartnerNews.jsx'
import TabBar from '../../src/components/TabBar.jsx'

// 探针：把内部状态吐成 JSON 方便断言，并暴露 markSeen 按钮
export function Probe() {
  const { counts, tabDots, markSeen } = useUnread()
  return (
    <div>
      <div id="probe">{JSON.stringify({ counts, tabDots })}</div>
      <button id="seen-mood" onClick={() => markSeen('mood')}>
        seen-mood
      </button>
      <button id="seen-pokes" onClick={() => markSeen('pokes')}>
        seen-pokes
      </button>
    </div>
  )
}

export function Harness({ activeTab }) {
  return (
    <UnreadProvider activeTab={activeTab}>
      <Probe />
      <PartnerNews />
      <TabBar active={activeTab} onChange={() => {}} />
    </UnreadProvider>
  )
}
