/**
 * Realtime 生命周期：页面常驻后，隐藏的 tab 不该继续占着订阅与轮询。
 *
 * 目标行为：
 *   - 可见：订阅 + 查询；收到本空间事件 → 重拉
 *   - 隐藏：移除频道、摘掉 visibilitychange/online 监听、不再发查询（数据保留，切回不闪）
 *   - 切回 / 回到前台 / 断网重连：自动重订阅并补拉一次（这就是「重连」策略）
 *   - DELETE 事件按 payload.old.couple_id 过滤：别的空间删东西不触发本空间刷新
 */
import { useState } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { resetSupabase, sbApi, stub } from './helpers/supabase-stub-module.js'
import { TabActiveContext, useCollection, usePagedCollection } from '../src/lib/hooks.js'

const rowsOf = (n, coupleId = 'c1') =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    couple_id: coupleId,
    created_at: new Date(Date.now() - i * 1000).toISOString(),
  }))

/**
 * tab 可见性由 wrapper 自己的 state 驱动（RTL 的 wrapper 只收到 children，
 * 拿不到 initialProps），切换时走 act 保证 effect 同步跑完。
 */
function mountCollection(active = true, options = {}) {
  let setter = null
  const Wrapper = ({ children }) => {
    const [v, setV] = useState(active)
    setter = setV
    return <TabActiveContext.Provider value={v}>{children}</TabActiveContext.Provider>
  }
  const h = renderHook(() => useCollection('photos', 'c1', options), { wrapper: Wrapper })
  return { ...h, setActive: (v) => act(() => setter(v)) }
}

beforeEach(() => {
  resetSupabase({ db: { photos: rowsOf(3) } })
})

describe('可见页：订阅与查询', () => {
  it('挂载后拉一次数据并订阅一个频道', async () => {
    const { result } = mountCollection(true)
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.rows).toHaveLength(3)
    expect(stub.log.select.filter((s) => s.table === 'photos')).toHaveLength(1)
    expect(sbApi.activeChannels()).toHaveLength(1)
  })

  it('收到本空间 INSERT 事件后重拉', async () => {
    const { result } = mountCollection(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    stub.db.photos.push({ id: 'p9', couple_id: 'c1', created_at: new Date().toISOString() })

    await act(async () => {
      sbApi.emit('photos', { eventType: 'INSERT', new: { id: 'p9', couple_id: 'c1' } })
    })
    await waitFor(() => expect(result.current.rows).toHaveLength(4))
    expect(stub.log.select.filter((s) => s.table === 'photos')).toHaveLength(2)
  })

  it('DELETE 事件按 old.couple_id 过滤：别的空间删除不刷新', async () => {
    const { result } = mountCollection(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    const before = stub.log.select.length

    await act(async () => {
      sbApi.emit('photos', { eventType: 'DELETE', old: { id: 'x', couple_id: 'c2' } })
    })
    expect(stub.log.select.length).toBe(before) // 不是本空间：不管

    // 本空间：另一端删了一条（库里已经没了），事件到达后列表要跟上
    stub.db.photos = stub.db.photos.slice(1)
    await act(async () => {
      sbApi.emit('photos', { eventType: 'DELETE', old: { id: 'p0', couple_id: 'c1' } })
    })
    expect(stub.log.select.length).toBeGreaterThan(before)
    await waitFor(() => expect(result.current.rows).toHaveLength(2))
  })

  it('old 里没有 couple_id 时保守刷新（宁可多刷不可漏刷）', async () => {
    const { result } = mountCollection(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    const before = stub.log.select.length
    stub.db.photos = stub.db.photos.slice(1)
    await act(async () => {
      sbApi.emit('photos', { eventType: 'DELETE', old: { id: 'p0' } })
    })
    expect(stub.log.select.length).toBeGreaterThan(before)
    await waitFor(() => expect(result.current.rows).toHaveLength(2))
  })
})

describe('隐藏页：暂停订阅', () => {
  it('切走后移除频道且不再发查询，数据保留不闪烁', async () => {
    const { result, setActive } = mountCollection(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(sbApi.activeChannels()).toHaveLength(1)

    setActive(false)
    await waitFor(() => expect(sbApi.activeChannels()).toHaveLength(0))
    expect(sbApi.removedChannelCount()).toBe(1)

    const before = stub.log.select.length
    // 隐藏期间的事件与可见性变化都不该触发查询
    await act(async () => {
      sbApi.emit('photos', { eventType: 'INSERT', new: { id: 'x', couple_id: 'c1' } })
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('online'))
    })
    expect(stub.log.select.length).toBe(before)
    expect(result.current.rows).toHaveLength(3) // 旧数据还在，切回不闪
  })

  it('enabled=false 时也完全停用', async () => {
    const { result } = mountCollection(true, { enabled: false })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows).toHaveLength(0)
    expect(stub.log.select).toHaveLength(0)
    expect(sbApi.activeChannels()).toHaveLength(0)
  })
})

describe('回到前台 / 断网重连：补拉与重订阅', () => {
  it('切回可见：重新订阅并补拉一次', async () => {
    const { result, setActive } = mountCollection(true)
    await waitFor(() => expect(result.current.loading).toBe(false))

    setActive(false)
    await waitFor(() => expect(sbApi.activeChannels()).toHaveLength(0))
    // 隐藏期间别人删了一条
    stub.db.photos = stub.db.photos.slice(1)

    const before = stub.log.select.length
    setActive(true)
    await waitFor(() => expect(stub.log.select.length).toBe(before + 1))
    expect(sbApi.activeChannels()).toHaveLength(1)
    await waitFor(() => expect(result.current.rows).toHaveLength(2)) // 补拉拿到了最新数据
  })

  it('回到前台 / 网络恢复都补拉一次', async () => {
    const { result } = mountCollection(true)
    await waitFor(() => expect(result.current.loading).toBe(false))

    let before = stub.log.select.length
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(stub.log.select.length).toBe(before + 1))

    before = stub.log.select.length
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    await waitFor(() => expect(stub.log.select.length).toBe(before + 1))
    expect(result.current.rows).toHaveLength(3)
  })

  it('卸载时频道被清理，不留悬挂订阅', async () => {
    const { unmount } = mountCollection(true)
    await waitFor(() => expect(sbApi.activeChannels()).toHaveLength(1))
    unmount()
    expect(sbApi.activeChannels()).toHaveLength(0)
    expect(sbApi.removedChannelCount()).toBe(1)
  })
})

describe('usePagedCollection：分页同样受生命周期约束', () => {
  it('首屏只取一页，loadMore 增量追加', async () => {
    resetSupabase({ db: { photos: rowsOf(70) } })
    const { result } = renderHook(() => usePagedCollection('photos', 'c1', { pageSize: 30 }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.rows).toHaveLength(30)
    expect(result.current.hasMore).toBe(true)
    const first = stub.log.select.at(-1)

    await act(async () => {
      await result.current.loadMore()
    })
    expect(result.current.rows).toHaveLength(60)
    await act(async () => {
      await result.current.loadMore()
    })
    expect(result.current.rows).toHaveLength(70)
    expect(result.current.hasMore).toBe(false)
    expect(first).toBeTruthy()
  })

  it('隐藏时不订阅，切回后补拉已加载深度', async () => {
    resetSupabase({ db: { photos: rowsOf(70) } })
    let setter = null
    const Wrapper = ({ children }) => {
      const [v, setV] = useState(true)
      setter = setV
      return <TabActiveContext.Provider value={v}>{children}</TabActiveContext.Provider>
    }
    const { result } = renderHook(() => usePagedCollection('photos', 'c1', { pageSize: 30 }), {
      wrapper: Wrapper,
    })
    const setActive = (v) => act(() => setter(v))
    await waitFor(() => expect(result.current.rows).toHaveLength(30))
    await act(async () => {
      await result.current.loadMore()
    })
    expect(result.current.rows).toHaveLength(60)

    setActive(false)
    await waitFor(() => expect(sbApi.activeChannels()).toHaveLength(0))

    const before = stub.log.select.length
    await act(async () => {
      await result.current.loadMore() // 隐藏时点「加载更多」是 no-op
    })
    expect(stub.log.select.length).toBe(before)

    setActive(true)
    await waitFor(() => expect(result.current.rows).toHaveLength(60)) // 深度保留，不退化回首屏
    expect(stub.log.select.length).toBe(before + 1)
  })
})
