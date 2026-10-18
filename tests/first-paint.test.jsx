/**
 * 「先画结构，再填数据」
 *
 * 目标：页面不应在查询回来之前是一片空白或一个大转圈。
 *
 *  1. 列表数据有本地缓存（lib/collectionCache.js）：首帧就把上次的内容画出来，请求照发
 *  2. 没有任何东西可画时才出骨架屏，且骨架的外框尺寸与真卡片一致（数据到达不跳）
 *  3. 真数据回来后整段覆盖 —— React 按 key 复用节点，视觉上就是局部替换
 *  4. 图片必须有明确的宽高/比例约束，不留高度等着加载完再撑开
 *
 * 注意：缓存只负责「先画出来」，可见性仍由 Supabase RLS 决定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, renderHook, screen, waitFor } from '@testing-library/react'
import { resetSupabase, sbApi, stub } from './helpers/supabase-stub-module.js'
import { StoreProvider } from '../src/lib/store.jsx'
import { TabActiveContext, usePagedCollection } from '../src/lib/hooks.js'
import { clearRows, listCacheKey, readRows, writeRows } from '../src/lib/collectionCache.js'
import { writeLocalSession } from './helpers/local-session.js'
import PhotoGrid from '../src/views/photos/PhotoGrid.jsx'
import { MessageBody } from '../src/views/messages/MessageCard.jsx'
import Messages from '../src/views/Messages.jsx'
import Diary from '../src/views/Diary.jsx'

const NS = 'love.list.v1'
const USER = { id: 'u1', is_anonymous: true }
const ME = { id: 'mb1', couple_id: 'c1', user_id: 'u1', nickname: '我', created_at: '2026-01-01T00:00:00Z' }
const TA = { id: 'mb2', couple_id: 'c1', user_id: 'u2', nickname: 'TA', created_at: '2026-01-02T00:00:00Z' }
const COUPLE = { id: 'c1', code: 'ABC234', created_at: '2026-01-01T00:00:00Z' }
const SPACE_KEY = 'love.space.v1'

// 日期筛选默认「今天」，fixture 必须落在今天，否则首帧就被筛掉了
const today = () => new Date().toISOString()

const msg = (over = {}) => ({
  id: 'm1',
  couple_id: 'c1',
  author_user_id: 'u1',
  content: '今天也想你',
  created_at: today(),
  ...over,
})
const note = (over = {}) => ({
  id: 'd1',
  couple_id: 'c1',
  author_user_id: 'u1',
  content: '今天吃了你推荐的那家店',
  mood: '开心',
  images: [],
  created_at: today(),
  ...over,
})

// TabActiveContext 默认值就是 true，但它必须由 Provider 显式给值，直接把 Provider 当 wrapper 会拿到 undefined
const ActiveTab = ({ children }) => <TabActiveContext.Provider value={true}>{children}</TabActiveContext.Provider>

// 让 StoreProvider 首帧就有 coupleId：与 bootstrap 用例同一套空间缓存
// ⚠ 还得写本机会话：store 只在「能同步确认缓存属于当前身份」时才 adopt，否则一个字段都不画
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

// resetSupabase 会把上一轮注册的 RPC 处理清掉，所以每个用到 store 的用例都要重新登记，
// 否则 bootstrap 失败后回退路径会查不到 couples → 判定「不在任何空间」→ 把缓存清了
function boot(extraDb = {}) {
  resetSupabase({ db: { couples: [COUPLE], members: [ME, TA], ...extraDb } })
  sbApi.setUser(USER)
  sbApi.onRpc('bootstrap_space', async () => ({
    data: { user: USER, couple: COUPLE, members: [ME, TA], milestones: [], anniversary: null, next_meetup: null },
    error: null,
  }))
}

const mount = (ui) => render(<StoreProvider>{ui}</StoreProvider>)
const skeletonCount = () => document.querySelectorAll('[data-skeleton="true"]').length
const text = () => document.body.textContent || ''

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe('列表本地缓存', () => {
  it('写进去能按 table+coupleId 读回来，互不串门', () => {
    writeRows('messages', 'c1', [{ id: 'm1' }])
    expect(readRows('messages', 'c1')).toHaveLength(1)
    expect(readRows('messages', 'c2')).toHaveLength(0)
    expect(readRows('diary_entries', 'c1')).toHaveLength(0)
    expect(listCacheKey('messages', 'c1')).toBe(`${NS}:messages:c1`)
  })

  it('超过 7 天没刷新过的缓存直接作废（连 key 一起删）', () => {
    writeRows('messages', 'c1', [{ id: 'm1' }])
    const key = listCacheKey('messages', 'c1')
    const rec = JSON.parse(window.localStorage.getItem(key))
    window.localStorage.setItem(key, JSON.stringify({ ...rec, savedAt: Date.now() - 8 * 24 * 3600 * 1000 }))

    expect(readRows('messages', 'c1')).toHaveLength(0)
    expect(window.localStorage.getItem(key)).toBeNull()
  })

  it('体积过大就不写：宁可不缓存也不占满配额', () => {
    const fat = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, content: 'x'.repeat(5000) }))
    writeRows('messages', 'c1', fat)
    expect(window.localStorage.getItem(listCacheKey('messages', 'c1'))).toBeNull()
    expect(readRows('messages', 'c1')).toHaveLength(0)
  })

  it('写入空数组 = 清掉旧缓存（全删完不该下次打开又冒出来）', () => {
    writeRows('messages', 'c1', [{ id: 'm1' }])
    writeRows('messages', 'c1', [])
    expect(readRows('messages', 'c1')).toHaveLength(0)
    expect(window.localStorage.getItem(listCacheKey('messages', 'c1'))).toBeNull()
  })

  it('缓存坏掉（非法 JSON）时安全返回空，不抛异常', () => {
    window.localStorage.setItem(listCacheKey('messages', 'c1'), '{不是 json')
    expect(() => readRows('messages', 'c1')).not.toThrow()
    expect(readRows('messages', 'c1')).toHaveLength(0)
  })

  it('clearRows 只清指定集合', () => {
    writeRows('messages', 'c1', [{ id: 'm1' }])
    writeRows('photos', 'c1', [{ id: 'p1' }])
    clearRows('messages', 'c1')
    expect(readRows('messages', 'c1')).toHaveLength(0)
    expect(readRows('photos', 'c1')).toHaveLength(1)
  })
})

describe('钩子：首帧就有内容', () => {
  it('首次渲染（未 await）就返回缓存行，但查询照发', async () => {
    resetSupabase({ db: { messages: [msg({ id: 'm-new', content: '新的一条' })] } })
    writeRows('messages', 'c1', [msg({ id: 'm-old', content: '上次缓存的那句' })])

    const { result } = renderHook(
      () => usePagedCollection('messages', 'c1', { orderBy: 'created_at', ascending: false }),
      { wrapper: ActiveTab },
    )

    // 关键点：这里没有 await —— 页面第一帧拿到的就是缓存内容
    expect(result.current.rows.map((r) => r.id)).toEqual(['m-old'])
    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows.map((r) => r.id)).toEqual(['m-new'])
    expect(stub.log.select.filter((s) => s.table === 'messages')).toHaveLength(1)
  })

  it('数据回来后写回缓存（只留第一页的量）', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => msg({ id: `m${i}`, created_at: today() }))
    resetSupabase({ db: { messages: rows } })

    const { result } = renderHook(
      () => usePagedCollection('messages', 'c1', { orderBy: 'created_at', ascending: false, pageSize: 5 }),
      { wrapper: ActiveTab },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(readRows('messages', 'c1')).toHaveLength(5)
  })

  it('换空间时不串上一个空间的内容，立刻切到新空间的缓存', () => {
    writeRows('messages', 'c1', [msg({ id: 'm-old', content: '上一个空间的留言' })])
    writeRows('messages', 'c2', [msg({ id: 'm-c2', couple_id: 'c2', content: '这个空间的留言' })])

    const { result, rerender } = renderHook(
      ({ cid }) => usePagedCollection('messages', cid, { orderBy: 'created_at', ascending: false }),
      { wrapper: ActiveTab, initialProps: { cid: 'c1' } },
    )
    expect(result.current.rows.map((r) => r.id)).toEqual(['m-old'])

    rerender({ cid: 'c2' })
    expect(result.current.rows.map((r) => r.id)).toEqual(['m-c2'])
  })
})

describe('页面：没有东西可画时才出骨架', () => {
  it('留言页首帧：只有骨架，没有转圈、没有真内容', async () => {
    boot({ messages: [msg({ content: '今天也想你' })] })
    seedSpace()

    mount(<Messages />)

    expect(skeletonCount()).toBeGreaterThan(0)
    expect(text()).not.toContain('加载中')
    expect(screen.queryByText('今天也想你')).toBeNull()

    await waitFor(() => expect(screen.getByText('今天也想你')).toBeTruthy())
  })

  it('日记页首帧：骨架站住结构，转圈文案不再出现', async () => {
    boot({ diary_entries: [note({ content: '今天吃了你推荐的那家店' })] })
    seedSpace()

    mount(<Diary />)

    expect(skeletonCount()).toBeGreaterThan(0)
    expect(text()).not.toContain('加载中')
    expect(screen.queryByText('今天吃了你推荐的那家店')).toBeNull()

    await waitFor(() => expect(screen.getByText('今天吃了你推荐的那家店')).toBeTruthy())
  })

  it('照片墙：骨架瓦片用 aspect-square，和真网格同高（不会重排）', () => {
    const { container } = render(<PhotoGrid {...gridProps({ list: [], loading: true })} />)
    expect(container.querySelectorAll('.aspect-square')).toHaveLength(6)
    expect(container.querySelector('.grid-cols-2')).not.toBeNull()
    expect(text()).not.toContain('加载中')
  })

  it('照片墙：时间线模式的骨架列数与真时间线一致（3 列）', () => {
    const { container } = render(
      <PhotoGrid {...gridProps({ list: [], loading: true, browseMode: 'timeline' })} />,
    )
    expect(container.querySelector('.grid-cols-3')).not.toBeNull()
  })

  it('照片墙：有东西可画就不再出骨架（即使还在 loading）', () => {
    const p = { id: 'p1', couple_id: 'c1', author_user_id: 'u1', storage_path: 'photos/c1/a.jpg', created_at: today() }
    const { container } = render(<PhotoGrid {...gridProps({ list: [p], loading: true })} />)
    expect(container.querySelectorAll('.aspect-square[data-skeleton="true"]')).toHaveLength(0)
    expect(container.querySelector('img')).not.toBeNull()
  })
})

describe('文本先显示缓存内容，真数据回来后替换', () => {
  it('留言：首帧画缓存的旧文，真数据到达后被替换', async () => {
    boot({ messages: [msg({ id: 'm-new', content: '新的一条' })] })
    writeRows('messages', 'c1', [msg({ id: 'm-old', content: '上次缓存的那句' })])
    seedSpace()

    mount(<Messages />)

    // 未 await：首帧就是缓存内容
    expect(screen.getByText('上次缓存的那句')).toBeTruthy()
    expect(screen.queryByText('新的一条')).toBeNull()

    await waitFor(() => expect(screen.getByText('新的一条')).toBeTruthy())
    expect(screen.queryByText('上次缓存的那句')).toBeNull()
    // 骨架也已经退场
    expect(skeletonCount()).toBe(0)
  })

  it('日记：缓存先出，随后被真数据覆盖', async () => {
    boot({ diary_entries: [note({ id: 'd-new', content: '新写的一篇日记' })] })
    writeRows('diary_entries', 'c1', [note({ id: 'd-old', content: '上次缓存的日记' })])
    seedSpace()

    mount(<Diary />)

    expect(screen.getByText('上次缓存的日记')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('新写的一篇日记')).toBeTruthy())
    expect(screen.queryByText('上次缓存的日记')).toBeNull()
  })
})

describe('图片不能靠加载来撑高度', () => {
  it('留言图：img 与骨架共用 aspect-[4/3]（排高从一开始就定死）', () => {
    const m = { id: 'm1', image_path: 'messages/a.jpg', content: '', voice_path: null }
    const { container, rerender } = render(<MessageBody m={m} voiceSrcs={{}} imgSrcs={{}} onOpenImage={() => {}} />)
    expect(container.querySelector('[data-skeleton="true"]').className).toContain('aspect-[4/3]')

    rerender(
      <MessageBody
        m={m}
        voiceSrcs={{}}
        imgSrcs={{ 'messages/a.jpg': 'https://cdn.test/a.jpg?token=1' }}
        onOpenImage={() => {}}
      />,
    )
    const img = container.querySelector('img')
    expect(img.className).toContain('aspect-[4/3]')
    expect(img.className).toContain('object-cover')
  })
})

function gridProps(over = {}) {
  return {
    active: { kind: 'all' },
    list: [],
    loading: false,
    browseMode: 'grid',
    setBrowseMode: vi.fn(),
    selectMode: false,
    setSelectMode: vi.fn(),
    setSelected: vi.fn(),
    selected: [],
    dragPhoto: null,
    setDragPhoto: vi.fn(),
    setDragOverAlbum: vi.fn(),
    toggleSelect: vi.fn(),
    setView: vi.fn(),
    timelineGroups: [],
    pinnedFirst: (l) => l,
    thumbSrcOf: () => 'https://cdn.test/thumb.jpg?token=1',
    liveAlbums: [],
    pendingPhotoIds: new Set(),
    hasMore: false,
    loadingMore: false,
    loadMore: vi.fn(),
    ...over,
  }
}
