/**
 * 未读按 userId + coupleId 隔离
 *
 * 未读基线存在 localStorage，按「用户 + 空间」双维度分桶。串扰的后果很直观：
 * 换了个空间（或换了个浏览器身份）却看到别人的红点，或者刚看完的内容又冒出来。
 * 这里把「同用户换空间」「不同用户」两条隔离线都测掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { stub, resetSupabase } from './helpers/supabase-stub-module.js'
import { UnreadProvider, useUnread } from '../src/lib/unread.jsx'

// 空间上下文是全局单例，测试里直接替换成想要的用户/空间
const storeRef = vi.hoisted(() => ({ value: null }))
vi.mock('../src/lib/store.jsx', () => ({
  useStore: () => storeRef.value,
  StoreProvider: ({ children }) => children,
}))

const OLD = '2026-01-01T00:00:00.000Z'
const NOW = new Date().toISOString()
const NEWER = new Date(Date.now() + 60000).toISOString()

const setStore = (uid, coupleId) => {
  storeRef.value = {
    user: { id: uid },
    coupleId,
    partner: { user_id: uid === 'u1' ? 'u2' : 'u1' },
    members: [],
    couple: { id: coupleId },
    loading: false,
    refresh: vi.fn(),
    enterSpace: vi.fn(),
    leaveSpace: vi.fn(),
  }
}

function Probe() {
  const { counts } = useUnread()
  return <div data-testid="counts">{JSON.stringify(counts)}</div>
}

const counts = () => JSON.parse(screen.getByTestId('counts').textContent)
const baselineOf = (uid) => JSON.parse(localStorage.getItem(`love_unread_v1_${uid}`) || 'null')

function mount(activeTab = 'home') {
  return render(
    <UnreadProvider activeTab={activeTab}>
      <Probe />
    </UnreadProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  resetSupabase({
    db: {
      messages: [
        { id: 'm1', couple_id: 'c1', author_user_id: 'u2', created_at: NOW },
        { id: 'm2', couple_id: 'c1', author_user_id: 'u1', created_at: NOW }, // 自己的不算
        { id: 'm3', couple_id: 'c2', author_user_id: 'u2', created_at: NOW },
      ],
      message_comments: [],
      diary_comments: [],
      pokes: [],
      moods: [],
    },
  })
})

describe('同一个用户换空间', () => {
  it('新空间以「现在」为基线：老内容不淹没未读，之后的新留言才算', async () => {
    setStore('u1', 'c1')
    mount()
    // 首次进入 c1：基线=现在 → db 里的 NOW 留言不晚于基线，未读 0
    await waitFor(() => expect(counts().messages).toBe(0))

    // 之后来的新留言才算未读（回前台触发重查，等价于真实使用里的补拉）
    stub.db.messages.push({ id: 'm9', couple_id: 'c1', author_user_id: 'u2', created_at: NEWER })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(counts().messages).toBe(1))
  })

  it('两个空间的基线互不串扰，切回来未读还在', async () => {
    // c1 的老基线：db 里那条 NOW 留言就是未读
    localStorage.setItem(
      'love_unread_v1_u1',
      JSON.stringify({ couples: { c1: { messages: OLD, diary: OLD, pokes: OLD, moodInit: false } } }),
    )
    setStore('u1', 'c1')
    const view = mount()
    await waitFor(() => expect(counts().messages).toBe(1))

    // 切到 c2：没有基线 → 以现在为基线，c2 那条留言不算未读
    setStore('u1', 'c2')
    view.rerender(
      <UnreadProvider activeTab="home">
        <Probe />
      </UnreadProvider>,
    )
    await waitFor(() => expect(counts().messages).toBe(0))

    // localStorage 里两个空间各自一份基线
    const saved = baselineOf('u1')
    expect(Object.keys(saved.couples).sort()).toEqual(['c1', 'c2'])
    expect(saved.couples.c1.messages).toBe(OLD) // c1 的基线没被 c2 覆盖

    // 切回 c1：未读恢复
    setStore('u1', 'c1')
    view.rerender(
      <UnreadProvider activeTab="home">
        <Probe />
      </UnreadProvider>,
    )
    await waitFor(() => expect(counts().messages).toBe(1))
  })
})

describe('不同用户互不串扰', () => {
  it('换用户后基线独立（同一浏览器两个身份）', async () => {
    localStorage.setItem(
      'love_unread_v1_u1',
      JSON.stringify({ couples: { c1: { messages: OLD, diary: OLD, pokes: OLD, moodInit: false } } }),
    )
    setStore('u1', 'c1')
    const first = mount()
    await waitFor(() => expect(counts().messages).toBe(1))

    // u2 首次进入同一个空间：全新基线，看不到 u1 的未读
    first.unmount() // 同一用例里只保留一棵树，避免两个探针混淆
    setStore('u2', 'c1')
    mount()
    await waitFor(() => expect(counts().messages).toBe(0))
    expect(baselineOf('u2')).toBeTruthy()
    expect(baselineOf('u1').couples.c1.messages).toBe(OLD)
  })
})

describe('看完即清', () => {
  it('进入留言页把基线吸收到当前时间，未读归零', async () => {
    localStorage.setItem(
      'love_unread_v1_u1',
      JSON.stringify({ couples: { c1: { messages: OLD, diary: OLD, pokes: OLD, moodInit: false } } }),
    )
    setStore('u1', 'c1')
    const view = mount('home')
    await waitFor(() => expect(counts().messages).toBe(1))

    // 切到留言页：视为看过了
    view.rerender(
      <UnreadProvider activeTab="messages">
        <Probe />
      </UnreadProvider>,
    )
    await waitFor(() => expect(counts().messages).toBe(0))
    const saved = baselineOf('u1').couples.c1
    expect(new Date(saved.messages).getTime()).toBeGreaterThan(new Date(OLD).getTime())
  })

  it('旧版扁平结构（只按 uid 存）自动迁移成按空间分桶', async () => {
    localStorage.setItem(
      'love_unread_v1_u1',
      JSON.stringify({ messages: OLD, diary: OLD, pokes: OLD, moodInit: false }),
    )
    setStore('u1', 'c1')
    const view = mount('home')
    await waitFor(() => expect(counts().messages).toBe(1)) // 旧基线被读出来用了

    // 第一次写入时落库成新结构 { couples: { c1: … } }
    view.rerender(
      <UnreadProvider activeTab="messages">
        <Probe />
      </UnreadProvider>,
    )
    await waitFor(() => expect(counts().messages).toBe(0))
    expect(baselineOf('u1').couples?.c1).toBeTruthy()
    expect(baselineOf('u1').couples?.c1?.messages).not.toBe(OLD) // 进入页面后被吸收成当前时间
  })
})
