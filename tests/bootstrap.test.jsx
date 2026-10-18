/**
 * 首屏启动流程（033 bootstrap_space）
 *
 * 目标：把「auth → 查我的成员 → couples/members/milestones 三连」这 3 段串行请求
 * 合成 1 段，并且本地有缓存时**首帧就把页面画出来**，不再干等网络。
 *
 *  1. 冷启动：匿名登录 → 一次 RPC 拿齐，不再逐表查询
 *  2. 已有会话：走 getSession 本地恢复，不重复匿名登录
 *  3. RPC 不可用（033 没跑）：自动回退原来的多请求路径
 *  4. 有缓存：首帧即有空间数据、loading 直接是 false（不卡 Spinner）
 *  5. 拿齐后把基础信息写进 localStorage
 *  6. 缓存属于另一个身份 → 弃用，绝不拿别人的空间顶着
 *  7. 后台校验发现会话失效 → 重新拿身份再拉一次（页面此时已经画出来了）
 *
 * 缓存只负责「先画出来」，能不能看这些数据始终由 Supabase RLS 决定。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { resetSupabase, sbApi, stub } from './helpers/supabase-stub-module.js'
import { writeLocalSession } from './helpers/local-session.js'
import { StoreProvider, useStore } from '../src/lib/store.jsx'
import { readRows, writeRows } from '../src/lib/collectionCache.js'

const CACHE_KEY = 'love.space.v1'
const USER = { id: 'u1', is_anonymous: true }
const OTHER = { id: 'm2', couple_id: 'c1', user_id: 'u2', nickname: 'TA', created_at: '2026-01-02T00:00:00Z' }
const ME = { id: 'm1', couple_id: 'c1', user_id: 'u1', nickname: '我', created_at: '2026-01-01T00:00:00Z' }

const payload = (over = {}) => ({
  user: USER,
  couple: { id: 'c1', code: 'ABC234', created_at: '2026-01-01T00:00:00Z' },
  my_member: ME,
  members: [ME, OTHER],
  milestones: [
    { id: 'ms1', couple_id: 'c1', type: 'anniversary', title: '在一起', date: '2024-05-20' },
    { id: 'ms2', couple_id: 'c1', type: 'meetup', title: '见面', date: '2099-01-01' },
  ],
  anniversary: { id: 'ms1', couple_id: 'c1', type: 'anniversary', title: '在一起', date: '2024-05-20' },
  next_meetup: { id: 'ms2', couple_id: 'c1', type: 'meetup', title: '见面', date: '2099-01-01' },
  ...over,
})

let latest = null
function Probe() {
  const s = useStore()
  latest = s
  return (
    <div>
      <span data-testid="couple">{s.coupleId || 'none'}</span>
      <span data-testid="loading">{s.loading ? 'loading' : 'ready'}</span>
      <span data-testid="members">{s.members.length}</span>
    </div>
  )
}

const boot = () => render(<StoreProvider><Probe /></StoreProvider>)
const rpcCalls = () => stub.log.rpc.filter((r) => r.name === 'bootstrap_space').length
const readCache = () => {
  const raw = window.localStorage.getItem(CACHE_KEY)
  return raw ? JSON.parse(raw) : null
}
const writeCache = (c) => window.localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 1, ...c }))

beforeEach(() => {
  resetSupabase()
  window.localStorage.clear()
  latest = null
  sbApi.onRpc('bootstrap_space', async () => ({ data: payload(), error: null }))
})

afterEach(() => {
  window.localStorage.clear()
})

describe('首屏一次拿齐', () => {
  it('冷启动：匿名登录后只发一次 RPC，不再逐表查询', async () => {
    sbApi.setAnonUser(USER)
    boot()
    await waitFor(() => expect(latest?.coupleId).toBe('c1'))

    expect(sbApi.authCalls()).toContain('signInAnonymously')
    expect(rpcCalls()).toBe(1)
    // 关键：couples / members / milestones 的逐表查询一次都没发生
    expect(stub.log.select.map((s) => s.table)).toEqual([])
    expect(latest.members).toHaveLength(2)
    expect(latest.derived?.nextMeetup?.title).toBe('见面')
  })

  it('已有会话：getSession 本地恢复，不重复匿名登录', async () => {
    sbApi.setUser(USER)
    boot()
    await waitFor(() => expect(latest?.coupleId).toBe('c1'))

    expect(sbApi.authCalls()[0]).toBe('getSession')
    expect(sbApi.authCalls()).not.toContain('signInAnonymously')
    expect(rpcCalls()).toBe(1)
  })

  it('RPC 不可用（033 未跑）：自动回退原来的多请求路径', async () => {
    sbApi.failRpc('bootstrap_space')
    resetSupabase({
      db: {
        members: [ME, OTHER],
        couples: [{ id: 'c1', code: 'ABC234', created_at: '2026-01-01T00:00:00Z' }],
        milestones: [{ id: 'ms1', couple_id: 'c1', type: 'anniversary', title: '在一起', date: '2024-05-20' }],
      },
    })
    sbApi.onRpc('bootstrap_space', async () => ({ data: null, error: null }))
    sbApi.failRpc('bootstrap_space')
    sbApi.setUser(USER)

    boot()
    await waitFor(() => expect(latest?.coupleId).toBe('c1'))

    // members（查我的成员）+ couples/members/milestones 三连
    const tables = stub.log.select.map((s) => s.table).sort()
    expect(tables).toEqual(['couples', 'members', 'members', 'milestones'])
    expect(latest.members).toHaveLength(2)
    expect(latest.derived?.anniversary?.date).toBe('2024-05-20')
  })
  it('冷启动不再先 getUser() 探一次（少一个 RTT）', async () => {
    sbApi.setAnonUser(USER)
    boot()
    await waitFor(() => expect(latest?.coupleId).toBe('c1'))

    // getSession 已经判定本机没有会话 → 直接匿名登录，中间那次联网探测纯属浪费
    //（看的是顺序：signIn 之前不允许出现 getUser 那次探测）
    expect(sbApi.authCalls().slice(0, 2)).toEqual(['getSession', 'signInAnonymously'])
  })
})

describe('缓存优先（不再干等网络）', () => {
  it('有缓存：首帧就有空间数据，loading 不是 true', async () => {
    writeCache({
      userId: 'u1',
      user: USER,
      coupleId: 'c1',
      couple: { id: 'c1', code: 'ABC234' },
      members: [ME, OTHER],
      milestones: [],
      derived: null,
    })
    writeLocalSession('u1') // 本机会话就是缓存的主人 → 允许认领
    sbApi.setUser(USER)

    boot()
    // 同步断言：还没有任何 await，网络请求都还没回来
    expect(latest.coupleId).toBe('c1')
    expect(latest.loading).toBe(false)
    expect(latest.members).toHaveLength(2)

    await waitFor(() => expect(rpcCalls()).toBe(1))
    expect(latest.members).toHaveLength(2)
  })

  it('拿齐后把基础信息写进 localStorage，下次可直接画出来', async () => {
    sbApi.setUser(USER)
    boot()
    await waitFor(() => expect(latest?.coupleId).toBe('c1'))

    const c = readCache()
    expect(c?.coupleId).toBe('c1')
    expect(c?.userId).toBe('u1')
    expect(c?.members).toHaveLength(2)
    expect(c?.derived?.anniversary?.date).toBe('2024-05-20')
  })

  it('缓存属于另一个身份：弃用，不拿别人的空间顶着', async () => {
    writeCache({
      userId: 'someone-else',
      coupleId: 'c-old',
      couple: { id: 'c-old', code: 'ZZZZZZ' },
      members: [{ id: 'x', user_id: 'someone-else', nickname: '陌生人' }],
      milestones: [],
    })
    sbApi.setUser(USER)
    sbApi.onRpc('bootstrap_space', async () => ({ data: payload({ couple: null, members: [], milestones: [] }), error: null }))

    boot()
    await waitFor(() => expect(latest?.couple).toBe(null))
    // 旧缓存已被清掉，不会被下次打开时拿来用
    expect(readCache()).toBe(null)
    expect(latest.coupleId).toBe(null)
  })

  it('后台校验发现会话失效：重新拿身份再拉一次', async () => {
    sbApi.setUser(USER)
    sbApi.expireSession() // getUser 返回 null，但 getSession 仍有旧值
    sbApi.setAnonUser({ id: 'u9', is_anonymous: true })

    boot()
    await waitFor(() => expect(sbApi.authCalls()).toContain('signInAnonymously'))
    await waitFor(() => expect(rpcCalls()).toBe(2))
  })
})

describe('首屏不卡在加载态', () => {
  it('有缓存时不渲染启动动画', async () => {
    writeCache({
      userId: 'u1',
      user: USER,
      coupleId: 'c1',
      couple: { id: 'c1', code: 'ABC234' },
      members: [ME, OTHER],
      milestones: [],
    })
    writeLocalSession('u1')
    sbApi.setUser(USER)
    boot()
    expect(screen.getByTestId('loading').textContent).toBe('ready')
    expect(screen.getByTestId('couple').textContent).toBe('c1')
  })

  it('无缓存时先进入加载态，拿到数据后就绪', async () => {
    sbApi.setUser(USER)
    boot()
    expect(screen.getByTestId('loading').textContent).toBe('loading')
    await waitFor(() => expect(screen.getByTestId('couple').textContent).toBe('c1'))
    expect(screen.getByTestId('loading').textContent).toBe('ready')
  })
})

/**
 * 身份先于渲染（P1）
 *
 * love.space.v1 里存的是**某一个用户**的空间。共用设备清掉登录状态、或换成另一个账号后
 * 它还在磁盘上 —— 以前首帧无条件 adopt，等于把上一个人的伴侣资料、情侣码、列表缓存
 * 先画给下一个使用者看。现在认领缓存有一条硬前提：必须能同步确认本机会话就是它的主人。
 */
describe('认领缓存前必须先确认身份', () => {
  const mine = () => {
    writeCache({
      userId: 'u1',
      user: USER,
      coupleId: 'c1',
      couple: { id: 'c1', code: 'ABC234' },
      members: [ME, OTHER],
      milestones: [],
    })
  }

  it('没有本地会话：一个字段都不 adopt，绝不给下一个人看', async () => {
    mine()
    // 顺手放一份「上一个人」的列表缓存：里面是真实的留言正文，比空间信息更私密
    writeRows('messages', 'c1', [{ id: 'm1', content: '上一个人留下的留言' }])
    // 注意：这里没有 writeLocalSession —— 模拟「共用设备刚清过登录状态」
    sbApi.setAnonUser({ id: 'u-new', is_anonymous: true })
    sbApi.onRpc('bootstrap_space', async () => ({ data: payload({ couple: null, members: [] }), error: null }))

    boot()

    // 同步断言：首帧（还没有任何 await）就没有空间数据
    expect(screen.getByTestId('couple').textContent).toBe('none')
    expect(screen.getByTestId('members').textContent).toBe('0')
    expect(screen.getByTestId('loading').textContent).toBe('loading')

    // 确认「本机确实没有会话」后，旧的空间缓存和列表缓存一起作废
    await waitFor(() => expect(readCache()).toBe(null))
    expect(readRows('messages', 'c1')).toHaveLength(0)
    // 新身份也没有被错当成缓存的主人
    await waitFor(() => expect(sbApi.authCalls()).toContain('signInAnonymously'))
    expect(screen.getByTestId('couple').textContent).toBe('none')
  })

  it('换了账号（会话是另一个人）：旧的一个字都不露，缓存被销毁', async () => {
    mine()
    writeLocalSession('someone-else')
    sbApi.setUser({ id: 'someone-else', is_anonymous: true })
    sbApi.onRpc('bootstrap_space', async () => ({ data: payload({ couple: null, members: [] }), error: null }))

    boot()
    expect(screen.getByTestId('couple').textContent).toBe('none')
    await waitFor(() => expect(readCache()).toBe(null))
    await waitFor(() => expect(sbApi.authCalls()).toContain('getSession'))
    expect(screen.getByTestId('couple').textContent).toBe('none')
  })

  it('会话就是缓存主人：照旧首帧即渲染（性能不回退）', () => {
    mine()
    writeLocalSession('u1')
    sbApi.setUser(USER)
    boot()

    expect(screen.getByTestId('couple').textContent).toBe('c1')
    expect(screen.getByTestId('members').textContent).toBe('2')
    expect(screen.getByTestId('loading').textContent).toBe('ready')
  })
})
