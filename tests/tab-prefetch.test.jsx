/**
 * 页签分包预加载的策略测试。
 *
 * 覆盖三件事：①什么时候允许后台预热（省流/2g 一律不预热）；②后台最多只拉一个、
 * 拉哪个（按历史点击次数）；③按下页签立刻拉（TabBar 集成）。
 *
 * tabPrefetch.js 是纯模块（不含 UI），直接 import 跑；每次用例前 resetModules
 * 拿一个新的实例，避免「已加载集合」在用例之间串味。5 个页面入口用 vi.mock 换成
 * 空组件，动态 import 不会真的把整页依赖树拉进来。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import TabBar from '../src/components/TabBar.jsx'

const root = process.cwd()
const read = (p) => readFileSync(path.join(root, p), 'utf8')
const flush = () => new Promise((r) => setTimeout(r, 0))

// 页面入口换成空组件：这里的用例只关心「有没有被拉过来」，不需要真的加载页面依赖树。
// Peace 故意做成加载失败，用来验证「预加载失败不能炸页面」。
vi.mock('../src/views/Diary.jsx', () => ({ default: () => null, __esModule: true }))
vi.mock('../src/views/Photos.jsx', () => ({ default: () => null, __esModule: true }))
vi.mock('../src/views/Messages.jsx', () => ({ default: () => null, __esModule: true }))
vi.mock('../src/views/Period.jsx', () => ({ default: () => null, __esModule: true }))
vi.mock('../src/views/Peace.jsx', () => {
  throw new Error('chunk 加载失败（模拟部署期间 404）')
})

const fresh = async () => {
  vi.resetModules()
  return import('../src/views/tabPrefetch.js')
}

const setConnection = (conn) => {
  Object.defineProperty(navigator, 'connection', { value: conn, configurable: true })
}
const dropConnection = () => {
  Reflect.deleteProperty(navigator, 'connection')
}

describe('后台预热的网络门槛', () => {
  it('省流模式：一个都不预热', async () => {
    const { networkCheap } = await fresh()
    setConnection({ saveData: true, effectiveType: '4g' })
    expect(networkCheap()).toBe(false)
    dropConnection()
  })

  it('2g / slow-2g：一个都不预热', async () => {
    const { networkCheap } = await fresh()
    setConnection({ effectiveType: '2g' })
    expect(networkCheap()).toBe(false)
    setConnection({ effectiveType: 'slow-2g' })
    expect(networkCheap()).toBe(false)
    dropConnection()
  })

  it('3g/4g 与不支持 networkInformation 时照常预热', async () => {
    const { networkCheap } = await fresh()
    setConnection({ effectiveType: '3g' })
    expect(networkCheap()).toBe(true)
    setConnection({ effectiveType: '4g' })
    expect(networkCheap()).toBe(true)
    dropConnection()
    expect(networkCheap()).toBe(true)
  })
})

describe('预测「下一个最可能点的页签」', () => {
  it('没有历史时不瞎猜，返回 null', async () => {
    const m = await fresh()
    localStorage.clear()
    expect(m.mostLikelyTab()).toBeNull()
  })

  it('挑历史上点得最多的那个', async () => {
    const m = await fresh()
    localStorage.clear()
    m.recordTabHit('photos')
    m.recordTabHit('diary')
    m.recordTabHit('diary')
    expect(m.mostLikelyTab()).toBe('diary')
  })

  it('次数相同时取最近点过的', async () => {
    const m = await fresh()
    localStorage.clear()
    m.recordTabHit('diary')
    m.recordTabHit('photos')
    expect(m.mostLikelyTab()).toBe('photos')
    m.recordTabHit('diary')
    expect(m.mostLikelyTab()).toBe('diary')
  })

  it('首页不参与预测（它是首屏静态引入，没有分包）', async () => {
    const m = await fresh()
    localStorage.clear()
    for (let i = 0; i < 20; i++) m.recordTabHit('home')
    expect(m.mostLikelyTab()).toBeNull()
  })

  it('历史写在 localStorage，下次打开还记得', async () => {
    const m = await fresh()
    localStorage.clear()
    m.recordTabHit('messages')
    expect(localStorage.getItem('love.tab.hits.v1')).toContain('messages')
    const again = await fresh()
    expect(again.mostLikelyTab()).toBe('messages')
  })
})

describe('分包加载本身', () => {
  it('同一个分包只加载一次', async () => {
    const m = await fresh()
    expect(m.prefetchTab('diary')).toBe(true)
    expect(m.prefetchTab('diary')).toBe(false) // 已在加载中/已加载
    await flush()
    expect([...m.loadedTabs()]).toContain('diary')
    expect(m.prefetchTab('diary')).toBe(false)
  })

  it('已经挂载过的页签不再重复拉', async () => {
    const m = await fresh()
    m.markLoaded('photos')
    expect(m.prefetchTab('photos')).toBe(false)
  })

  it('首页和未知页签不给假线索', async () => {
    const m = await fresh()
    expect(m.prefetchTab('home')).toBe(false)
    expect(m.prefetchTab('nothing')).toBe(false)
    expect(m.prefetchTab()).toBe(false)
  })

  it('加载失败不冒泡成未处理 rejection，且允许下次重试', async () => {
    const m = await fresh()
    expect(m.prefetchTab('peace')).toBe(true)
    await flush()
    await flush()
    expect([...m.loadedTabs()]).not.toContain('peace')
    expect(m.prefetchTab('peace')).toBe(true) // 失败后可重试（部署期间 chunk 404 就需要这个）
  })
})

describe('TabBar：按下即预加载', () => {
  it('按下哪个页签就预加载哪个，不连带其它', () => {
    const onPrefetch = vi.fn()
    render(<TabBar active="home" onChange={() => {}} onPrefetch={onPrefetch} />)
    fireEvent.pointerDown(screen.getByText('留言'))
    expect(onPrefetch).toHaveBeenCalledTimes(1)
    expect(onPrefetch).toHaveBeenCalledWith('messages')
  })

  it('点击仍然正常切页（预加载不能吃掉点击事件）', () => {
    const onChange = vi.fn()
    render(<TabBar active="home" onChange={onChange} onPrefetch={vi.fn()} />)
    fireEvent.click(screen.getByText('日记'))
    expect(onChange).toHaveBeenCalledWith('diary')
  })

  it('没传 onPrefetch 的老调用方不报错', () => {
    const onChange = vi.fn()
    render(<TabBar active="home" onChange={onChange} />)
    fireEvent.pointerDown(screen.getByText('照片'))
    fireEvent.click(screen.getByText('照片'))
    expect(onChange).toHaveBeenCalledWith('photos')
  })
})

describe('Dashboard 不再一次性拉齐所有分包', () => {
  const dash = read('src/views/Dashboard.jsx')

  it('动态分包入口全部收敛到 tabLoaders.js', () => {
    expect(dash).not.toMatch(/import\('\.\//) // Dashboard.jsx 里不得再出现动态 import
    const loaders = read('src/views/tabLoaders.js')
    expect((loaders.match(/import\('\.\/\w+\.jsx'\)/g) || []).length).toBe(5)
  })

  it('5 个页签仍然各自 lazy（共享同一份 loader）', () => {
    expect((dash.match(/lazy\(TAB_LOADERS\.\w+\)/g) || []).length).toBe(5)
    expect(dash).toContain("import Home from './Home.jsx'") // 首页依旧静态引入
  })

  it('后台预热受网络门槛限制，且最多拉一个', () => {
    expect(dash).toContain('if (!networkCheap()) return')
    expect(dash).toContain('const target = mostLikelyTab()')
    expect(dash).toMatch(/const warm = \(\) => \{\s*prefetchTab\(target\)\s*\}/)
    expect(dash).toContain('requestIdleCallback') // 仍然等首屏稳定（浏览器空闲）再拉
    expect(dash).toContain('cancelIdleCallback')
  })

  it('按下页签的预加载已接到 TabBar', () => {
    expect(dash).toContain('onPrefetch={prefetchTab}')
  })
})
