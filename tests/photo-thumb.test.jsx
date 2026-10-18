/**
 * 浏览列表只加载缩略图（绝不下原图）
 *
 * 原来的坑：`thumbPathOf = p.thumb_path || p.storage_path` —— 024 之前的旧照片没有缩略图，
 * 网格就去签 storage_path，手机上几 MB 一张，一屏十几张直接吃掉几十 MB 流量。
 *
 * 守住这几条：
 * 1. 缺缩略图时不再回退 storage_path，而是走服务端 480 变换；
 * 2. 批量签名里出现的只能是 thumb_path，不能出现原图路径；
 * 3. 后台补齐会真的生成缩略图文件并写回 thumb_path；
 * 4. 新照片强制带缩略图（480 压缩失败也要有兜底小图）；
 * 5. SmartImg 重试绝不「去参退回原图」——那会同时丢掉签名 token。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, fireEvent, screen } from '@testing-library/react'
import { resetSupabase, sbApi, stub } from './helpers/supabase-stub-module.js'
import { thumbPathOf, THUMB_TF } from '../src/views/photos/constants.js'
import { useThumbSrcs } from '../src/views/photos/useThumbSrcs.js'
import {
  useThumbBackfill,
  thumbBackfillFinished,
  thumbBackfillRunning,
} from '../src/views/photos/useThumbBackfill.js'
import { usePhotoUpload } from '../src/views/photos/usePhotoUpload.js'
import SmartImg from '../src/components/SmartImg.jsx'

// 压缩/并发依赖 canvas 与真实文件系统，测试里换成直通实现；
// 480 缩略图那一路要能「失败」——这正是要验证的兜底分支
vi.mock('../src/lib/image.js', () => ({
  compressImage: async (file, opts = {}) => {
    if (opts && opts.maxEdge === 480) throw new Error('canvas 不可用')
    return { file, before: 1000, after: 500 }
  },
  mapLimit: async (items, _n, fn) => {
    const out = []
    for (const it of items) out.push(await fn(it))
    return out
  },
  saveImage: async () => 'downloaded',
  downloadImages: async (list) => ({ saved: list.length, failed: 0 }),
  isIOSDevice: () => false,
}))

const NEW = { id: 'p1', storage_path: 'photos/c1/new.jpg', thumb_path: 'thumbs/c1/new.jpg' }
const OLD = { id: 'p2', storage_path: 'photos/c1/old.jpg', thumb_path: null }

const setConnection = (conn) =>
  Object.defineProperty(navigator, 'connection', { value: conn, configurable: true })
const dropConnection = () => Reflect.deleteProperty(navigator, 'connection')

// 补齐任务排在空闲回调之后（不跟首屏图片抢带宽），所以要先把这一轮兑现掉。
// jsdom 没有 requestIdleCallback，setup.js 用「下一轮宏任务」兜底。
const settle = async (ms = 20) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

// 可控的 requestIdleCallback：把「已经排好队、但还没轮到空闲」这个窗口固定住。
// setup.js 的兜底是「下一轮宏任务立刻兑现」，盖不住排队与回调之间的时序。
const installIdle = () => {
  const origRIC = window.requestIdleCallback
  const origCIC = window.cancelIdleCallback
  const queue = []
  let nextId = 1
  window.requestIdleCallback = (cb) => {
    const id = nextId++
    queue.push({ id, cb })
    return id
  }
  window.cancelIdleCallback = (id) => {
    const i = queue.findIndex((q) => q.id === id)
    if (i >= 0) queue.splice(i, 1)
  }
  return {
    pending: () => queue.length,
    flush: async () => {
      const items = queue.splice(0)
      await act(async () => {
        items.forEach((i) => i.cb({ didTimeout: false, timeRemaining: () => 50 }))
      })
    },
    restore: () => {
      window.requestIdleCallback = origRIC
      window.cancelIdleCallback = origCIC
    },
  }
}

beforeEach(() => {
  resetSupabase({ db: { photos: [NEW, OLD], albums: [] } })
  thumbBackfillFinished.clear()
  thumbBackfillRunning.clear()
})

afterEach(() => {
  dropConnection()
})

describe('thumbPathOf：不再回退原图', () => {
  it('有 thumb_path 用缩略图', () => {
    expect(thumbPathOf(NEW)).toBe('thumbs/c1/new.jpg')
  })

  it('没有 thumb_path 返回 null（调用方走 480 变换兜底，而不是原图）', () => {
    expect(thumbPathOf(OLD)).toBe(null)
  })
})

describe('useThumbSrcs：两层来源都只出小图', () => {
  // 一次挂载里同时核对两条通道：签名 URL 有内存缓存，拆成两个用例第二个会命中缓存、看不到请求
  it('批量签名只签 thumb_path；缺缩略图的旧照片走 480 cover 变换单签', async () => {
    const { result } = renderHook(() => useThumbSrcs([NEW, OLD]))
    await act(async () => {})

    const batch = stub.log.sign.find((s) => Array.isArray(s.paths))
    expect(batch.paths).toEqual(['thumbs/c1/new.jpg'])
    expect(batch.paths).not.toContain('photos/c1/old.jpg')

    const one = stub.log.sign.filter((s) => s.path === 'photos/c1/old.jpg')
    expect(one.length).toBeGreaterThan(0)
    expect(one[0].opts).toEqual({ transform: THUMB_TF })
    expect(result.current(OLD)).toMatch(/token=1/)
  })

  it('有缩略图的照片拿到的是缩略图地址', async () => {
    const { result } = renderHook(() => useThumbSrcs([NEW, OLD]))
    await act(async () => {})
    expect(result.current(NEW)).toBe('https://sign.test/photos/thumbs/c1/new.jpg?token=1')
  })
})

describe('useThumbBackfill：旧照片补成真实缩略图', () => {
  const thumbs = (prefix = 'thumbs/') => stub.log.upload.filter((u) => u.path.startsWith(prefix))
  const okBlob = () => {
    globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob(['x'], { type: 'image/jpeg' }) })
  }

  it('补一份 thumbs/ 文件并把 thumb_path 写回数据库', async () => {
    okBlob()
    const onDone = vi.fn()
    renderHook(() => useThumbBackfill({ rows: [OLD], coupleId: 'c1', onDone }))
    // ⚠ 挂载这一刻还没上传：任务被排到空闲了，首屏那批缩略图先走
    expect(thumbs()).toHaveLength(0)
    await settle()

    const uploaded = thumbs()
    expect(uploaded.length).toBe(1)
    const upd = stub.log.update.filter((u) => u.table === 'photos')
    expect(upd.length).toBe(1)
    expect(upd[0].patch).toEqual({ thumb_path: uploaded[0].path })
    expect(onDone).toHaveBeenCalled()
  })

  it('同一空间一次会话只补一轮，不会反复上传', async () => {
    okBlob()
    const { rerender } = renderHook(() => useThumbBackfill({ rows: [OLD], coupleId: 'c1' }))
    await settle()
    rerender()
    await settle()
    expect(thumbs().length).toBe(1)
    expect(thumbs()).toHaveLength(1)
  })

  // ⚠ 排队标记是先写的、idle 回调是后跑的：中间 effect 可能被清理（rows 又变了）。
  //   标记写了却不收回 = 这个空间再也排不进队列；反过来，回调已经开工还去清标记 = 重复补一轮。
  //   下面两条用例各自守住一种时序。
  it('排队期间被清理（rows 变了）→ 旧回调取消、新回调照样补，且只补一次', async () => {
    okBlob()
    const idle = installIdle()
    const OLD_B = { id: 'p4', storage_path: 'photos/c1/old-b.jpg', thumb_path: null }
    try {
      const { rerender } = renderHook((p) => useThumbBackfill({ rows: p.rows, coupleId: 'c1' }), {
        initialProps: { rows: [OLD] },
      })
      expect(idle.pending()).toBe(1) // 已排队，还没轮到空闲

      rerender({ rows: [OLD_B] }) // effect 重跑：旧排队被取消、换成新的一轮
      // 旧回调真的被取消（不是叠加成两个），否则同一批照片会被补两遍
      expect(idle.pending()).toBe(1)

      await idle.flush() // 现在才轮到空闲
      await settle()
      expect(thumbs()).toHaveLength(1)
      expect(stub.log.update.filter((u) => u.table === 'photos')).toHaveLength(1)
    } finally {
      idle.restore()
    }
  })

  it('回调已开工后再 rerender → 不重新排队（runningIds / finished 去重）', async () => {
    okBlob()
    const idle = installIdle()
    const OLD_B = { id: 'p4', storage_path: 'photos/c1/old-b.jpg', thumb_path: null }
    try {
      const { rerender } = renderHook((p) => useThumbBackfill({ rows: p.rows, coupleId: 'c1' }), {
        initialProps: { rows: [OLD] },
      })
      await idle.flush() // idle 回调跑过：任务已经开工
      await settle()
      expect(thumbs()).toHaveLength(1)

      rerender({ rows: [OLD_B] })
      expect(idle.pending()).toBe(0) // 没再排第二轮
      await idle.flush()
      await settle()
      expect(thumbs()).toHaveLength(1)
      expect(thumbBackfillFinished.has('c1')).toBe(true)
      expect(thumbBackfillRunning.size).toBe(0)
    } finally {
      idle.restore()
    }
  })

  it('补齐失败静默：不发上传、不打断浏览', async () => {
    globalThis.fetch = async () => ({ ok: false })
    renderHook(() => useThumbBackfill({ rows: [OLD], coupleId: 'c1' }))
    await settle()
    expect(thumbs()).toHaveLength(0)
    expect(stub.log.update.length).toBe(0)
  })

  it('省流模式下本轮干脆不补（用户明确要求省流量）', async () => {
    okBlob()
    setConnection({ saveData: true, effectiveType: '4g' })
    renderHook(() => useThumbBackfill({ rows: [OLD], coupleId: 'c1' }))
    await settle()
    expect(thumbs()).toHaveLength(0)
  })

  // ⚠ 曾经踩过的坑：排队标记是个布尔 ref，照片页保持挂载、只换 coupleId（切换空间）时
  //   旧空间置上的标记不会重置，新空间就永远排不进补齐队列 —— 后台补齐在新空间静默失效。
  it('切换空间后，新空间照样能排队补齐（同一时刻只跑一轮）', async () => {
    let release
    const gate = new Promise((r) => {
      release = r
    })
    // c1 这一轮故意卡在下载上，制造「旧空间还在跑」的现场
    globalThis.fetch = async () => {
      await gate
      return { ok: true, blob: async () => new Blob(['x'], { type: 'image/jpeg' }) }
    }
    const OLD2 = { id: 'p3', storage_path: 'photos/c2/old.jpg', thumb_path: null }
    const { rerender } = renderHook((p) => useThumbBackfill({ rows: p.rows, coupleId: p.cid }), {
      initialProps: { cid: 'c1', rows: [OLD] },
    })
    await settle()
    okBlob() // gate 放行前的那次调用已被闭包捕获，之后的下载立刻返回

    rerender({ cid: 'c2', rows: [OLD2] })
    await settle()
    // c1 还没跑完 → c2 排在后面，不跟它并行抢带宽
    expect(thumbs('thumbs/c2/')).toHaveLength(0)

    release()
    await settle(40)
    expect(thumbs('thumbs/c1/')).toHaveLength(1)
    expect(thumbs('thumbs/c2/')).toHaveLength(1)
    expect(thumbBackfillRunning.size).toBe(0)
  })

  it('2g / slow-2g 同样不补，且不记账（网好了还能补）', async () => {
    okBlob()
    setConnection({ effectiveType: '2g' })
    const { unmount } = renderHook(() => useThumbBackfill({ rows: [OLD], coupleId: 'c1' }))
    await settle()
    expect(thumbs()).toHaveLength(0)
    expect(thumbBackfillFinished.has('c1')).toBe(false)

    // 切回来时用同样的网络＝弱网 → 依然不补；换成正常网络后立刻补上
    unmount()
    setConnection({ effectiveType: '4g' })
    renderHook(() => useThumbBackfill({ rows: [OLD], coupleId: 'c1' }))
    await settle()
    expect(thumbs()).toHaveLength(1)
  })
})

describe('新照片强制带缩略图', () => {
  it('480 压缩失败也要传一份小图（thumb_path 不留空）', async () => {
    const { result } = renderHook(() =>
      usePhotoUpload({ coupleId: 'c1', user: { id: 'u1' }, rows: [], active: { kind: 'unfiled' }, reload: () => {} }),
    )
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' })
    await act(async () => {
      await result.current.pickFiles({ target: { files: [file], value: '' } })
    })
    await act(async () => {
      await result.current.doUpload()
    })
    const inserted = stub.log.insert.filter((i) => i.table === 'photos')
    expect(inserted.length).toBe(1)
    expect(inserted[0].rows[0].thumb_path).toMatch(/^thumbs\/c1\/.+\.jpg$/)
  })
})

describe('SmartImg 重试不退回原图', () => {
  it('重试保留签名 token 与变换参数，绝不去 query', () => {
    const src = 'https://sign.test/photos/thumbs/c1/a.jpg?token=1&width=480'
    render(<SmartImg src={src} alt="缩略图" />)
    const img = () => screen.getByAltText('缩略图')
    fireEvent.error(img())
    const retried = img().getAttribute('src')
    expect(retried).toContain('token=1')
    expect(retried).toContain('width=480')
    expect(retried).toMatch(/_r=\d+/)
  })

  it('三次都失败才出占位，且占位里没有 img', () => {
    const src = 'https://sign.test/photos/thumbs/c1/a.jpg?token=1'
    const { container } = render(<SmartImg src={src} alt="缩略图" />)
    for (let i = 0; i < 3; i++) fireEvent.error(screen.getByAltText('缩略图'))
    expect(screen.getByTitle('加载失败，点击重试')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })
})

// sbApi 在本文件用于「失败注入」的可读性，避免被当作未使用
void sbApi
