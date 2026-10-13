/**
 * 单人空间删除：空间里只有一个人时没有「TA」可以点头，
 * 删除直接生效（软删进最近删除，30 天内可自己找回），绝不产生审批请求。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { resetSupabase, sbApi, stub } from './helpers/supabase-stub-module.js'
import { getToastItems } from '../src/lib/toast.jsx'
import { usePhotoDeletion } from '../src/views/photos/usePhotoDeletion.js'

const NOW = '2026-10-13T00:00:00.000Z'
const texts = () => getToastItems().map((t) => t.text)

const photo = (over = {}) => ({
  id: 'p1',
  couple_id: 'c1',
  author_user_id: 'u1',
  storage_path: 'photos/c1/a.jpg',
  original_path: 'originals/c1/a.jpg',
  thumb_path: 'thumbs/c1/a.jpg',
  album_id: null,
  deleted_at: null,
  created_at: NOW,
  ...over,
})

const album = (over = {}) => ({ id: 'a1', couple_id: 'c1', name: '旅行', deleted_at: null, ...over })

function props(over = {}) {
  return {
    coupleId: 'c1',
    user: { id: 'u1' },
    rows: [photo()],
    albums: [],
    reqRows: [],
    reload: vi.fn(),
    reloadAlbums: vi.fn(),
    reloadRequests: vi.fn(),
    isSolo: true,
    ...over,
  }
}

beforeEach(() => {
  resetSupabase({ db: { photos: [photo()], albums: [], delete_requests: [] } })
  globalThis.__TOAST__.clear()
})

describe('单人空间：删除直接生效', () => {
  it('删照片：软删进最近删除，不写审批请求', async () => {
    const p = props()
    const { result } = renderHook((x) => usePhotoDeletion(x), { initialProps: p })

    await act(async () => {
      await result.current.requestDelete({ kind: 'photo', ids: ['p1'] })
    })

    expect(stub.db.delete_requests).toHaveLength(0)
    expect(stub.db.photos[0].deleted_at).toBeTruthy()
    expect(stub.db.photos[0].deleted_by).toBe('u1')
    expect(texts().join('\n')).toMatch(/只有你一个人/)
    expect(p.reload).toHaveBeenCalled()
  })

  it('删图集：照片先移出图集，再软删图集', async () => {
    resetSupabase({
      db: {
        photos: [photo({ album_id: 'a1' }), photo({ id: 'p2', album_id: 'a1' })],
        albums: [album()],
        delete_requests: [],
      },
    })
    const onAlbumDeleted = vi.fn()
    const p = props({
      rows: stub.db.photos,
      albums: stub.db.albums,
      onAlbumDeleted,
    })
    const { result } = renderHook((x) => usePhotoDeletion(x), { initialProps: p })

    await act(async () => {
      await result.current.requestDelete({ kind: 'album', ids: ['a1'], label: '旅行' })
    })

    expect(stub.db.albums[0].deleted_at).toBeTruthy()
    // 图集没了，里面的照片回到「未分组」而不是跟着一起消失
    expect(stub.db.photos.every((x) => x.album_id === null)).toBe(true)
    expect(stub.db.photos.every((x) => x.deleted_at === null)).toBe(true)
    expect(onAlbumDeleted).toHaveBeenCalled()
    expect(stub.db.delete_requests).toHaveLength(0)
  })

  it('写库失败：如实提示，照片保持原状（不会「以为删了其实还在」）', async () => {
    sbApi.failUpdate('photos', 'network error')
    const p = props()
    const { result } = renderHook((x) => usePhotoDeletion(x), { initialProps: p })

    await act(async () => {
      await result.current.requestDelete({ kind: 'photo', ids: ['p1'] })
    })

    expect(stub.db.photos[0].deleted_at).toBe(null)
    const all = texts().join('\n')
    expect(all).toMatch(/删除失败/)
    expect(all).toMatch(/没有被改动/)
    expect(p.reload).not.toHaveBeenCalled()
  })

  it('双人空间绝不直删：哪怕传错 isSolo 也会走申请', async () => {
    const p = props({ isSolo: false })
    const { result } = renderHook((x) => usePhotoDeletion(x), { initialProps: p })

    await act(async () => {
      await result.current.requestDelete({ kind: 'photo', ids: ['p1'] })
    })

    expect(stub.db.delete_requests).toHaveLength(1)
    expect(stub.db.photos[0].deleted_at).toBe(null)
  })
})

describe('单人空间：删掉的东西仍在最近删除里', () => {
  it('软删后出现在 trashItems，可自行恢复', async () => {
    const p = props({ rows: [photo({ deleted_at: NOW })] })
    const { result } = renderHook((x) => usePhotoDeletion(x), { initialProps: p })

    expect(result.current.trashItems).toHaveLength(1)
    expect(result.current.trashItems[0].kind).toBe('photo')

    await act(async () => {
      await result.current.restoreItem(result.current.trashItems[0])
    })
    expect(stub.db.photos[0].deleted_at).toBe(null)
    expect(stub.db.photos[0].deleted_by).toBe(null)
  })

  it('超过 30 天的过期项不再出现在回收站（会被懒清理真删）', async () => {
    const old = new Date(Date.now() - 31 * 86400000).toISOString()
    const p = props({ rows: [photo({ deleted_at: old })] })
    const { result } = renderHook((x) => usePhotoDeletion(x), { initialProps: p })

    expect(result.current.trashItems).toHaveLength(0)
    // 懒清理：过期的行会被真删，文件一起清掉
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(stub.db.photos).toHaveLength(0)
    expect(stub.log.remove.length).toBeGreaterThan(0)
  })
})
