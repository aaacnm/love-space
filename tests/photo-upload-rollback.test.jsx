/**
 * 图片上传失败回滚
 * 上传链路最容易留下「孤儿文件」：文件传上去了，数据库记录没写进去，
 * 用户看不见这张照片，存储里却白白占着空间。这里的断言全部围绕「不留残留」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { resetSupabase, sbApi, stub } from './helpers/supabase-stub-module.js'
import { getToastItems } from '../src/lib/toast.jsx'
import { rollbackUploads, uploadOne } from '../src/views/photos/upload.js'
import { usePhotoUpload } from '../src/views/photos/usePhotoUpload.js'

// 图片压缩/保存依赖 canvas 与真实文件系统，这里换成直通实现，
// 被测目标是「上传 + 入库 + 回滚」的编排逻辑
vi.mock('../src/lib/image.js', () => ({
  compressImage: async (file) => ({ file, before: 1000, after: 500 }),
  mapLimit: async (items, _n, fn) => {
    const out = []
    for (const it of items) out.push(await fn(it))
    return out
  },
  saveImage: async () => 'downloaded',
  downloadImages: async (list) => ({ saved: list.length, failed: 0 }),
  isIOSDevice: () => false,
}))

const texts = () => getToastItems().map((t) => t.text)
const file = (name = 'a.jpg') => new File(['x'], name, { type: 'image/jpeg' })

beforeEach(() => {
  resetSupabase({ db: { photos: [], albums: [] } })
  globalThis.__TOAST__.clear()
})

describe('uploadOne / rollbackUploads', () => {
  it('上传成功返回存储路径', async () => {
    const path = await uploadOne('c1', file())
    expect(path).toMatch(/^photos\/c1\/.+\.jpg$/)
    expect(stub.files.has(path)).toBe(true)
  })

  it('上传失败返回 null 并提示，不留半截路径', async () => {
    sbApi.failUpload('storage full')
    const path = await uploadOne('c1', file())
    expect(path).toBe(null)
    expect(texts().join('\n')).toMatch(/照片上传失败/)
  })

  it('回滚去重：同一路径只删一次', async () => {
    await rollbackUploads(['photos/a.jpg', 'photos/a.jpg', 'originals/a.jpg', null, undefined])
    expect(stub.log.remove).toHaveLength(1)
    expect(stub.log.remove[0].paths).toEqual(['photos/a.jpg', 'originals/a.jpg'])
  })

  it('回滚空列表不发起请求', async () => {
    const res = await rollbackUploads([])
    expect(res.error).toBe(null)
    expect(stub.log.remove).toHaveLength(0)
    expect(await rollbackUploads(null)).toEqual({ error: null })
  })

  it('回滚失败如实返回 error（调用方据此提示）', async () => {
    sbApi.failRemove('network down')
    const res = await rollbackUploads(['photos/a.jpg'])
    expect(res.error).toEqual({ message: 'network down' })
  })
})

describe('doUpload：入库失败整批撤回', () => {
  function setup(over = {}) {
    const p = {
      coupleId: 'c1',
      user: { id: 'u1' },
      rows: [],
      active: { kind: 'unfiled' },
      reload: vi.fn(),
      ...over,
    }
    const h = renderHook((x) => usePhotoUpload(x), { initialProps: p })
    act(() => {
      h.result.current.setPending([{ orig: file(), file: file(), url: 'blob:1', before: 1000, after: 500, thumb: file() }])
    })
    return { ...h, p }
  }

  it('全部成功：写一条记录，三份文件都上传', async () => {
    const { result, p } = setup()
    await act(async () => {
      await result.current.doUpload()
    })

    expect(stub.db.photos).toHaveLength(1)
    const row = stub.db.photos[0]
    expect(row.storage_path).toMatch(/^photos\//)
    expect(row.thumb_path).toMatch(/^thumbs\//)
    expect(row.original_path).toMatch(/^originals\//)
    expect(row.couple_id).toBe('c1')
    expect(stub.log.remove).toHaveLength(0) // 成功不回滚
    expect(p.reload).toHaveBeenCalled()
    expect(result.current.pending).toHaveLength(0)
  })

  it('入库失败：本批已上传的文件统一撤回，一条不留', async () => {
    const { result } = setup()
    sbApi.failInsert('photos', 'new row violates row-level security')

    await act(async () => {
      await result.current.doUpload()
    })

    expect(stub.db.photos).toHaveLength(0)
    const removed = stub.log.remove.at(-1).paths
    expect(removed).toHaveLength(3)
    expect(removed.some((x) => x.startsWith('photos/'))).toBe(true)
    expect(removed.some((x) => x.startsWith('thumbs/'))).toBe(true)
    expect(removed.some((x) => x.startsWith('originals/'))).toBe(true)
    expect(stub.files.size).toBe(0) // 存储里没有孤儿
    expect(texts().join('\n')).toMatch(/已自动清理/)
  })

  it('缺迁移导致入库失败：去掉新字段重试，并引导跑迁移', async () => {
    const { result } = setup()
    // 只失败第一次：重试（去掉 original_path / thumb_path）应当成功
    sbApi.failInsert('photos', 'column photos.original_path does not exist', true)

    await act(async () => {
      await result.current.doUpload()
    })

    expect(stub.db.photos).toHaveLength(1)
    expect(stub.db.photos[0].original_path).toBeUndefined()
    expect(stub.log.remove).toHaveLength(0) // 重试成功，不回滚
    expect(texts().join('\n')).toMatch(/migrations\/018_photo_original\.sql/)
  })

  it('主图都没传成功时不会写库、也不会误删文件', async () => {
    const { result } = setup()
    sbApi.failUpload('network')

    await act(async () => {
      await result.current.doUpload()
    })

    expect(stub.log.insert.filter((i) => i.table === 'photos')).toHaveLength(0)
    expect(stub.log.remove).toHaveLength(0)
  })
})
