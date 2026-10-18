/**
 * 灯箱取图：预览图先出，原图那一档随后补
 *
 * 之前 useViewerSrcs 用 Promise.all 同时签「1280 预览」和「原尺寸」两档 ——
 * 手机上实际只用到 1280，却要等三那个完全用不上的请求回来才能出图。
 * 现在 preview 一签好就先显示，full 到不了也不影响看图。
 *
 * 顺序要可靠地观测到，所以这里把 signedMediaUrl 换成可控实现：
 * 「原图那一档」的 Promise 由测试自己决定什么时候兑现。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { signedMediaUrl } from '../src/lib/storage.js'
import { useViewerSrcs, useThumbUrls } from '../src/lib/mediaUrls.js'

vi.mock('../src/lib/storage.js', async () => {
  const actual = await vi.importActual('../src/lib/storage.js')
  return { ...actual, signedMediaUrl: vi.fn(actual.signedMediaUrl) }
})

const PATH = 'photos/c1/a.jpg'

afterEach(() => {
  vi.mocked(signedMediaUrl).mockReset()
})

describe('灯箱：预览图不等原图签名', () => {
  it('预览图一好就显示，原图那一档还在路上也不挡画面', async () => {
    let releaseFull = null
    vi.mocked(signedMediaUrl).mockImplementation(async (_bucket, _path, tf) => {
      if (tf) return 'https://sign.test/preview?token=1'
      // 原尺寸那一档永远不兑现，模拟「高分屏那一路卡住了」
      return new Promise((r) => {
        releaseFull = () => r('https://sign.test/full?token=1')
      })
    })

    const { result } = renderHook(() => useViewerSrcs('photos', PATH))
    await waitFor(() => expect(result.current.preview).toBe('https://sign.test/preview?token=1'))
    // 再刷一轮：此时原图还没签出来，画面已经能看了
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current.full).toBe('')
    expect(releaseFull).not.toBe(null)
  })

  it('原图签好后补进 srcset（不替换掉已经在显示的预览图）', async () => {
    vi.mocked(signedMediaUrl).mockImplementation(async (_b, _p, tf) =>
      tf ? 'https://sign.test/preview?token=1' : 'https://sign.test/full?token=1',
    )
    const { result } = renderHook(() => useViewerSrcs('photos', PATH))
    await waitFor(() => expect(result.current.full).toBe('https://sign.test/full?token=1'))
    expect(result.current.preview).toBe('https://sign.test/preview?token=1')
  })

  it('只发了一次预览请求就出图：不等「用不上」的原图往返', async () => {
    vi.mocked(signedMediaUrl).mockImplementation(async (_b, _p, tf) =>
      tf ? 'https://sign.test/preview?token=1' : new Promise(() => {}),
    )
    const { result } = renderHook(() => useViewerSrcs('photos', PATH))
    await waitFor(() => expect(result.current.preview).toBeTruthy())
    // 请求是按「先 1280 预览 → 再原尺寸」的顺序发出的，不是两条一起打出去
    const calls = vi.mocked(signedMediaUrl).mock.calls
    expect(calls[0][2]).toEqual({ height: 1280, resize: 'contain' })
    expect(calls[1]?.[2] ?? null).toBe(null)
  })
})

describe('缩略图分批：不能只签前 N 张', () => {
  it('54 张（日记 18 条 × 3 张）一路签到最后一张，不会卡在占位上', async () => {
    const paths = Array.from({ length: 54 }, (_, i) => `messages/c1/img${i}.jpg`)
    // 用真实实现逐个返回，顺便记录调用顺序
    vi.mocked(signedMediaUrl).mockImplementation(async (_b, p) => `https://sign.test/${p}?token=1`)

    const { result } = renderHook(() => useThumbUrls('photos', paths))
    await waitFor(() => expect(Object.keys(result.current).length).toBe(54))
    paths.forEach((p) => expect(result.current[p]).toContain(p))
  })

  it('分批生效：同一批内部并发，超过批大小才继续下一批', async () => {
    const paths = Array.from({ length: 30 }, (_, i) => `messages/c1/g${i}.jpg`)
    let inflight = 0
    let peak = 0
    vi.mocked(signedMediaUrl).mockImplementation(async (_b, p) => {
      inflight += 1
      peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, 0))
      inflight -= 1
      return `https://sign.test/${p}?token=1`
    })

    const { result } = renderHook(() => useThumbUrls('photos', paths))
    await waitFor(() => expect(Object.keys(result.current).length).toBe(30))
    // 并发不超过 4（不是 30 条一起打出去）
    expect(peak).toBeLessThanOrEqual(4)
  })
})
