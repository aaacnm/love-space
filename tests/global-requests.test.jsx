/**
 * 首页 / 全局请求瘦身
 *
 * 以前一进首页同时打出去的东西：
 *   · 5 个 Realtime 频道（unread / notifier / poke-listener / moods / pokes）
 *   · 8 条 SQL：未读统计 5 条（messages / message_comments / diary_comments /
 *     pokes / moods）+ 戳一戳全表 + 心情全表 + PokeListener 的最新一条
 *
 * 现在的规矩：
 *   1. 一个空间只订阅一个频道 space-<coupleId>（lib/realtimeBus.js），谁都不许自建
 *   2. 未读统计推迟到首屏画完之后（lib/idle.js）才发
 *   3. 首页只要「今天的心情」和「最近一条戳一戳」，历史戳一戳点开记录才拉
 *   4. 评论在打开详情时才加载；表情回应推迟到主列表画完之后
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { resetSupabase, sbApi, stub } from './helpers/supabase-stub-module.js'
import { StoreProvider } from '../src/lib/store.jsx'
import { whenIdle } from '../src/lib/idle.js'
import { writeLocalSession } from './helpers/local-session.js'
import { activeBuses, resetBus, WATCHED_TABLES } from '../src/lib/realtimeBus.js'
import Dashboard from '../src/views/Dashboard.jsx'
import Diary from '../src/views/Diary.jsx'
import Messages from '../src/views/Messages.jsx'

const root = process.cwd()
const read = (p) => readFileSync(path.join(root, p), 'utf8') // 相对仓库根
const readAbs = (p) => readFileSync(p, 'utf8') // 遍历出来的绝对路径

const USER = { id: 'u1', is_anonymous: true }
const ME = { id: 'mb1', couple_id: 'c1', user_id: 'u1', nickname: '我', city: '上海', timezone: 'Asia/Shanghai' }
const TA = { id: 'mb2', couple_id: 'c1', user_id: 'u2', nickname: 'TA', city: '北京', timezone: 'Asia/Shanghai' }
const COUPLE = { id: 'c1', code: 'ABC234' }
const SPACE_KEY = 'love.space.v1'

const today = () => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const nowIso = () => new Date().toISOString()

const poke = (over = {}) => ({
  id: 'k1',
  couple_id: 'c1',
  from_user_id: 'u2',
  kind: 'poke',
  created_at: nowIso(),
  ...over,
})
const note = (over = {}) => ({
  id: 'd1',
  couple_id: 'c1',
  author_user_id: 'u1',
  content: '今天吃了你推荐的那家店',
  mood: '开心',
  images: [],
  created_at: nowIso(),
  ...over,
})
const msg = (over = {}) => ({
  id: 'm1',
  couple_id: 'c1',
  author_user_id: 'u1',
  content: '今天也想你',
  created_at: nowIso(),
  ...over,
})

// store 首帧就要有 coupleId，否则会去走引导流程（详见 first-paint 用例里的说明）
// ⚠ 本机会话也要写：store 确认身份后才认领空间缓存
function seedSpace() {
  window.localStorage.setItem(
    SPACE_KEY,
    JSON.stringify({
      v: 1,
      savedAt: Date.now(),
      userId: USER.id,
      user: USER,
      coupleId: COUPLE.id,
      couple: COUPLE,
      members: [ME, TA],
      milestones: [],
      derived: { anniversary: null, nextMeetup: null },
    }),
  )
  writeLocalSession(USER.id)
}

function boot(extraDb = {}) {
  resetBus()
  resetSupabase({
    db: {
      couples: [COUPLE],
      members: [ME, TA],
      moods: [{ id: 'md1', couple_id: 'c1', user_id: 'u2', mood: '甜蜜', date: today() }],
      pokes: [poke({ id: 'k1' }), poke({ id: 'k0', created_at: '2026-01-01T00:00:00Z' })],
      ...extraDb,
    },
  })
  sbApi.setUser(USER)
  sbApi.onRpc('bootstrap_space', async () => ({
    data: { user: USER, couple: COUPLE, members: [ME, TA], milestones: [], anniversary: null, next_meetup: null },
    error: null,
  }))
}

const selectsOf = (table) => stub.log.select.filter((s) => s.table === table)
// 全量查询：不带 limit、也不带「基线之后」的 gt 过滤。
// 未读统计那条 pokes 是增量查询（只取基线之后），不算把历史拉下来
const fullQueries = (table) =>
  selectsOf(table).filter((s) => s.limit === null && !s.filters.some((f) => f.op === 'gt'))
const mountDashboard = () => render(<StoreProvider>{<Dashboard />}</StoreProvider>)

beforeEach(() => {
  window.localStorage.clear()
  seedSpace()
})

describe('一个空间只有一个 Realtime 频道', () => {
  it('首页进来：未读中心 + 通知 + 戳一戳 + 心情共用同一个频道', async () => {
    boot()
    mountDashboard()
    await waitFor(() => expect(sbApi.activeChannels().length).toBeGreaterThan(0))

    // 关键断言：不管挂了多少个订阅方，频道数恒为 1，且名字就是空间级那个
    expect(sbApi.activeChannels()).toEqual(['space-c1'])
    const names = new Set(sbApi.activeChannels())
    expect(names.has('unread-c1')).toBe(false)
    expect(names.has('notifier-c1')).toBe(false)
    expect(names.has('poke-listener-c1')).toBe(false)

    // 总线的登记情况：所有订阅方都挂在同一条总线上
    const bus = activeBuses()[0]
    expect(bus.coupleId).toBe('c1')
    expect(bus.tables).toEqual(expect.arrayContaining(['moods', 'pokes', 'messages']))
    // 心情被「首页磁贴 + 未读中心」同时订阅：这正是以前要建两个频道的场景
    expect(bus.listeners.moods).toBeGreaterThan(1)
  })

  it('多个组件订阅同一张表：一次事件全部收到（总线按表分发）', async () => {
    boot()
    mountDashboard()
    await waitFor(() => expect(sbApi.activeChannels()).toEqual(['space-c1']))

    const before = selectsOf('pokes').length
    await waitFor(() =>
      expect(selectsOf('pokes').some((s) => s.limit === 1)).toBe(true),
    )

    // 对方戳一下：首页「最近一条」要更新（PokeSection 的 useLatestRow 订阅）
    stub.db.pokes.push(poke({ id: 'k9', created_at: new Date(Date.now() + 1000).toISOString() }))
    sbApi.emit('pokes', { eventType: 'INSERT', new: poke({ id: 'k9' }) })
    await waitFor(() => expect(selectsOf('pokes').length).toBeGreaterThan(before))

    // 顺带：戳一戳 toast 也要弹出来（PokeListener 挂在同一条总线上）
    await waitFor(() => expect(document.body.textContent).toContain('戳了你一下'))
  })

  it('最后一个订阅者退订 → 频道撤掉，不留悬挂订阅', async () => {
    boot()
    const view = mountDashboard()
    await waitFor(() => expect(sbApi.activeChannels()).toEqual(['space-c1']))

    view.unmount()
    await waitFor(() => expect(sbApi.activeChannels()).toEqual([]))
    expect(activeBuses()).toEqual([])
  })
})

describe('首页首屏不发未读统计', () => {
  it('首页要显示的东西先查，未读统计排在后面', async () => {
    boot({ messages: [msg({ id: 'm-new', author_user_id: 'u2' })] })
    mountDashboard()

    // 等到统计真的发出来（延迟到空闲之后）
    await waitFor(() => expect(selectsOf('messages').length).toBeGreaterThan(0))
    await waitFor(() => expect(selectsOf('diary_comments').length).toBeGreaterThan(0))
    expect(selectsOf('message_comments').length).toBeGreaterThan(0)

    // 顺序才是重点：首页要显示的内容（心情 / 最近一条戳）排在未读统计之前
    const order = stub.log.select.map((s) => s.table)
    expect(order.indexOf('moods')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('pokes')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('messages')).toBeGreaterThan(order.indexOf('moods'))
    expect(order.indexOf('messages')).toBeGreaterThan(order.indexOf('pokes'))
    expect(order.indexOf('diary_comments')).toBeGreaterThan(order.indexOf('moods'))
  })

  it('首页的心情只查今天，戳一戳只要最近一条', async () => {
    boot()
    mountDashboard()

    await waitFor(() => expect(selectsOf('moods').length).toBeGreaterThan(0))
    // 带 date 过滤，不是把两人所有历史心情都拉下来
    expect(selectsOf('moods')[0].filters).toEqual(
      expect.arrayContaining([{ op: 'eq', col: 'couple_id', val: 'c1' }, { op: 'eq', col: 'date', val: today() }]),
    )

    await waitFor(() => expect(selectsOf('pokes').length).toBeGreaterThan(0))
    expect(selectsOf('pokes').some((s) => s.limit === 1)).toBe(true)
  })

  it('whenIdle：同步不跑，空闲后才跑（未读统计用的就是它）', async () => {
    const spy = vi.fn()
    whenIdle(spy)
    expect(spy).not.toHaveBeenCalled() // 调用它的那一刻绝不能同步执行
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))

    // 取消掉就不该再跑
    const spy2 = vi.fn()
    whenIdle(spy2)()
    await new Promise((r) => setTimeout(r, 20))
    expect(spy2).not.toHaveBeenCalled()
  })
})

describe('历史戳一戳：展开才加载', () => {
  it('首页不拉全量，点开「戳一戳记录」才查', async () => {
    boot()
    mountDashboard()
    await waitFor(() => expect(selectsOf('pokes').length).toBeGreaterThan(0))

    // 首页这一刻还没把历史戳一戳拉下来（只有 limit 1 的那一条）
    expect(fullQueries('pokes')).toHaveLength(0)

    fireEvent.click(screen.getByText('戳一戳记录 ›'))
    // 弹窗里的完整卡片这时才挂载 → 全量查询随之发出
    await waitFor(() => expect(fullQueries('pokes').length).toBeGreaterThan(0))
    await waitFor(() => expect(document.body.textContent).toContain('我戳的'))
  })
})

describe('评论 / 表情回应：不跟主列表抢首屏', () => {
  it('日记页首屏不查评论，打开全文才查', async () => {
    boot({ diary_entries: [note()] })
    render(
      <StoreProvider>
        <Diary />
      </StoreProvider>,
    )
    await waitFor(() => expect(selectsOf('diary_entries').length).toBeGreaterThan(0))
    expect(selectsOf('diary_comments')).toHaveLength(0)

    // 点开全文 → 评论这时才加载
    fireEvent.click(screen.getByText(/今天吃了你推荐的那家店/))
    await waitFor(() => expect(selectsOf('diary_comments').length).toBeGreaterThan(0))
  })

  it('留言页首屏不查评论，点开 💬 才查；表情回应稍后补', async () => {
    boot({ messages: [msg()] })
    render(
      <StoreProvider>
        <Messages />
      </StoreProvider>,
    )
    await waitFor(() => expect(selectsOf('messages').length).toBeGreaterThan(0))
    expect(selectsOf('message_comments')).toHaveLength(0)

    // 表情回应直接长在卡片上，不能完全不拉 —— 但也不跟主列表抢首屏，空闲后补上
    await waitFor(() => expect(selectsOf('message_reactions').length).toBeGreaterThan(0))

    fireEvent.click(screen.getAllByText(/评论/)[0])
    await waitFor(() => expect(selectsOf('message_comments').length).toBeGreaterThan(0))
  })
})

describe('总线表清单的兜底扫描', () => {
  it('源码里订阅的每张表都在 WATCHED_TABLES 里（漏一张 = 静默不刷新）', () => {
    const files = ['src/views', 'src/components', 'src/lib'].flatMap((dir) => {
      const { readdirSync, statSync } = require('node:fs')
      const walk = (d) =>
        readdirSync(d).flatMap((f) => {
          const p = path.join(d, f)
          return statSync(p).isDirectory() ? walk(p) : /\.(js|jsx)$/.test(p) ? [p] : []
        })
      return walk(path.join(root, dir))
    })
    const src = files.map(readAbs)

    const used = new Set()
    for (const code of src) {
      for (const m of code.matchAll(/use(?:Collection|PagedCollection)\(\s*'([a-z_]+)'/g)) used.add(m[1])
      // 未读中心与通知横幅是直接用表名登记订阅的
      for (const m of code.matchAll(/subscribeTable\(\s*coupleId,\s*'([a-z_]+)'/g)) used.add(m[1])
    }
    const declared = new Set(WATCHED_TABLES)
    expect([...used].filter((t) => !declared.has(t))).toEqual([])
    expect(used.size).toBeGreaterThan(5) // 扫描本身要真的扫到东西
  })

  it('通知规则里的表也都登记了监听', () => {
    const notifier = read('src/components/Notifier.jsx')
    const tables = [...notifier.matchAll(/table:\s*'([a-z_]+)'/g)].map((m) => m[1])
    expect(tables.length).toBeGreaterThan(3)
    for (const t of tables) expect(WATCHED_TABLES).toContain(t)
  })
})
