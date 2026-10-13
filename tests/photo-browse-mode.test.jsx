/**
 * 相册浏览模式（网格 / 时间线）按 userId + coupleId 隔离
 * 同一台设备上两个人、或者一个人进出过多个空间，偏好不能互相覆盖。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { browseKeyOf, loadBrowse, saveBrowse } from '../src/views/photos/constants.js'
import { usePhotoMemory } from '../src/views/photos/useAlbums.js'

const saved = (uid) => JSON.parse(localStorage.getItem(browseKeyOf(uid)) || 'null')

function props(over = {}) {
  return {
    coupleId: 'c1',
    uid: 'u1',
    rows: [],
    livePhotos: [],
    memberMap: {},
    rangeOf: () => null,
    ...over,
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('存储层：双维度 key', () => {
  it('默认网格；写入后按 用户+空间 分桶', () => {
    expect(loadBrowse('u1', 'c1')).toBe('grid')
    saveBrowse('u1', 'c1', 'timeline')
    expect(loadBrowse('u1', 'c1')).toBe('timeline')
    expect(saved('u1').couples.c1.mode).toBe('timeline')
  })

  it('换空间互不影响', () => {
    saveBrowse('u1', 'c1', 'timeline')
    expect(loadBrowse('u1', 'c2')).toBe('grid')
    saveBrowse('u1', 'c2', 'grid')
    expect(loadBrowse('u1', 'c1')).toBe('timeline')
    expect(Object.keys(saved('u1').couples).sort()).toEqual(['c1', 'c2'])
  })

  it('换用户互不影响', () => {
    saveBrowse('u1', 'c1', 'timeline')
    expect(loadBrowse('u2', 'c1')).toBe('grid')
    expect(saved('u2')).toBe(null)
  })

  it('最多保留最近 4 个空间，最久没访问的老空间被淘汰', () => {
    // 已有 4 个空间的历史记录（t 越小 = 越久没访问）
    localStorage.setItem(
      browseKeyOf('u1'),
      JSON.stringify({
        couples: {
          c1: { mode: 'grid', t: 1 },
          c2: { mode: 'timeline', t: 2 },
          c3: { mode: 'grid', t: 3 },
          c4: { mode: 'timeline', t: 4 },
        },
      }),
    )
    saveBrowse('u1', 'c5', 'timeline')

    const keys = Object.keys(saved('u1').couples).sort()
    expect(keys).toHaveLength(4)
    expect(keys).not.toContain('c1') // 最久没访问的被挤掉
    expect(keys).toEqual(['c2', 'c3', 'c4', 'c5'])
    // 老空间的配置丢了也不影响使用：读不到就回落到默认网格
    expect(loadBrowse('u1', 'c1')).toBe('grid')
  })

  it('坏数据 / 旧结构不会让页面崩，安全回落到网格', () => {
    localStorage.setItem(browseKeyOf('u1'), '{ not json')
    expect(loadBrowse('u1', 'c1')).toBe('grid')
    localStorage.setItem(browseKeyOf('u1'), JSON.stringify({ mode: 'timeline' })) // 旧扁平结构
    expect(loadBrowse('u1', 'c1')).toBe('grid')
    expect(() => saveBrowse('u1', 'c1', 'grid')).not.toThrow()
  })
})

describe('usePhotoMemory：运行时跟随账号/空间切换', () => {
  it('切换设置后写入当前 用户+空间', async () => {
    const { result } = renderHook((p) => usePhotoMemory(p), { initialProps: props() })
    expect(result.current.browseMode).toBe('grid')

    await act(async () => {
      result.current.setBrowseMode('timeline')
    })
    expect(result.current.browseMode).toBe('timeline')
    expect(saved('u1').couples.c1.mode).toBe('timeline')
  })

  it('换空间：重新播种为默认，且不污染原空间', async () => {
    const { result, rerender } = renderHook((p) => usePhotoMemory(p), { initialProps: props() })
    await act(async () => {
      result.current.setBrowseMode('timeline')
    })
    expect(saved('u1').couples.c1.mode).toBe('timeline')

    // 切到 c2：新的空间从默认值开始
    rerender(props({ coupleId: 'c2' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.browseMode).toBe('grid')
    expect(loadBrowse('u1', 'c1')).toBe('timeline') // c1 的设置没被覆盖

    // 切回 c1：恢复原设置
    rerender(props({ coupleId: 'c1' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.browseMode).toBe('timeline')
  })

  it('换用户：看到的是自己的偏好', async () => {
    saveBrowse('u1', 'c1', 'timeline')
    const { result, rerender } = renderHook((p) => usePhotoMemory(p), { initialProps: props({ uid: 'u1' }) })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.browseMode).toBe('timeline')

    rerender(props({ uid: 'u2' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.browseMode).toBe('grid')
    expect(saved('u1').couples.c1.mode).toBe('timeline')
  })
})
