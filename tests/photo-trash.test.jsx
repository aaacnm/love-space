/**
 * 最近删除：恢复 / 彻底删除
 *  - 恢复：把 deleted_at 抹掉，照片回到相册（不需要对方同意）
 *  - 彻底删除：真删数据库行 + 三份文件（浏览图/原图/缩略图），不可恢复
 *  - 失败语义：记录删了但文件没清掉 → 如实提示，不假装成功
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { resetSupabase, sbApi, stub } from './helpers/supabase-stub-module.js'
import { getToastItems } from '../src/lib/toast.jsx'
import { usePhotoDeletion } from '../src/views/photos/usePhotoDeletion.js'
import TrashModal from '../src/components/TrashModal.jsx'

const NOW = '2026-10-13T00:00:00.000Z'
const texts = () => getToastItems().map((t) => t.text)

const photo = (over = {}) => ({
  id: 'p1',
  couple_id: 'c1',
  author_user_id: 'u2',
  storage_path: 'photos/c1/a.jpg',
  original_path: 'originals/c1/a.jpg',
  thumb_path: 'thumbs/c1/a.jpg',
  deleted_at: NOW,
  created_at: NOW,
  ...over,
})
const album = (over = {}) => ({ id: 'a1', couple_id: 'c1', name: '旅行', deleted_at: NOW, ...over })

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
    isSolo: false,
    ...over,
  }
}

beforeEach(() => {
  resetSupabase({
    db: { photos: [photo()], albums: [], delete_requests: [] },
    files: ['photos/c1/a.jpg', 'originals/c1/a.jpg', 'thumbs/c1/a.jpg'],
  })
  globalThis.__TOAST__.clear()
})

describe('恢复', () => {
  it('照片恢复：清掉 deleted_at 与 deleted_by', async () => {
    const p = props()
    const { result } = renderHook((x) => usePhotoDeletion(x), { initialProps: p })

    await act(async () => {
      await result.current.restoreItem({ id: 'p1', kind: 'photo', deletedAt: NOW, photo: photo() })
    })

    expect(stub.db.photos[0].deleted_at).toBe(null)
    expect(stub.db.photos[0].deleted_by).toBe(null)
    // 恢复不动文件：三份都还在
    expect(stub.files.has('photos/c1/a.jpg')).toBe(true)
    expect(p.reload).toHaveBeenCalled()
  })

  it('图集恢复：提示照片回到了未分组', async () => {
    resetSupabase({ db: { photos: [], albums: [album()], delete_requests: [] } })
    const p = props({ albums: [album()], rows: [] })
    const { result } = renderHook((x) => usePhotoDeletion(x), { initialProps: p })

    await act(async () => {
      await result.current.restoreItem({ id: 'a1', kind: 'album', deletedAt: NOW, album: album() })
    })

    expect(stub.db.albums[0].deleted_at).toBe(null)
    expect(texts().join('\n')).toMatch(/未分组/)
  })

  it('恢复失败：提示失败，条目还在（可重试）', async () => {
    sbApi.failUpdate('photos', 'row level security')
    const p = props()
    const { result } = renderHook((x) => usePhotoDeletion(x), { initialProps: p })

    await act(async () => {
      await result.current.restoreItem({ id: 'p1', kind: 'photo', deletedAt: NOW, photo: photo() })
    })

    expect(stub.db.photos[0].deleted_at).toBe(NOW)
    expect(texts().join('\n')).toMatch(/恢复失败/)
  })
})

describe('彻底删除', () => {
  it('照片：先删行再删三份文件（去重后一次 remove）', async () => {
    const p = props()
    const { result } = renderHook((x) => usePhotoDeletion(x), { initialProps: p })

    await act(async () => {
      await result.current.purgeItem({ id: 'p1', kind: 'photo', deletedAt: NOW, photo: photo() })
    })

    expect(stub.db.photos).toHaveLength(0)
    const removed = stub.log.remove.at(-1).paths
    expect(removed.sort()).toEqual(['originals/c1/a.jpg', 'photos/c1/a.jpg', 'thumbs/c1/a.jpg'])
    expect(stub.files.size).toBe(0)
  })

  it('缩略图缺失时只清存在的两份，不报错', async () => {
    const p = props({ rows: [photo({ thumb_path: null })] })
    const { result } = renderHook((x) => usePhotoDeletion(x), { initialProps: p })

    await act(async () => {
      await result.current.purgeItem({
        id: 'p1',
        kind: 'photo',
        deletedAt: NOW,
        photo: photo({ thumb_path: null }),
      })
    })

    expect(stub.log.remove.at(-1).paths.sort()).toEqual(['originals/c1/a.jpg', 'photos/c1/a.jpg'])
  })

  it('行删掉但文件清理失败：如实提示，不让用户以为全删干净了', async () => {
    sbApi.failRemove('storage quota')
    const p = props()
    const { result } = renderHook((x) => usePhotoDeletion(x), { initialProps: p })

    await act(async () => {
      await result.current.purgeItem({ id: 'p1', kind: 'photo', deletedAt: NOW, photo: photo() })
    })

    expect(stub.db.photos).toHaveLength(0)
    expect(texts().join('\n')).toMatch(/文件清理失败/)
  })

  it('行都删不掉：提示可重试，条目留在回收站', async () => {
    sbApi.failDelete('photos', 'permission denied')
    const p = props()
    const { result } = renderHook((x) => usePhotoDeletion(x), { initialProps: p })

    await act(async () => {
      await result.current.purgeItem({ id: 'p1', kind: 'photo', deletedAt: NOW, photo: photo() })
    })

    expect(stub.db.photos).toHaveLength(1)
    expect(stub.log.remove).toHaveLength(0) // 没删行就不动文件
    expect(texts().join('\n')).toMatch(/彻底删除失败/)
  })

  it('图集：只删图集行，里面的照片不受影响', async () => {
    resetSupabase({ db: { photos: [photo({ album_id: 'a1', deleted_at: null })], albums: [album()], delete_requests: [] } })
    const p = props({ albums: [album()], rows: [photo({ album_id: 'a1', deleted_at: null })] })
    const { result } = renderHook((x) => usePhotoDeletion(x), { initialProps: p })

    await act(async () => {
      await result.current.purgeItem({ id: 'a1', kind: 'album', deletedAt: NOW, album: album() })
    })

    expect(stub.db.albums).toHaveLength(0)
    expect(stub.db.photos).toHaveLength(1)
  })

  it('一键清空：全部真删，失败项单独报数', async () => {
    resetSupabase({
      db: {
        photos: [photo({ id: 'p1' }), photo({ id: 'p2', storage_path: 'photos/c1/b.jpg' })],
        albums: [album()],
        delete_requests: [],
      },
    })
    const p = props({ rows: stub.db.photos, albums: stub.db.albums })
    const { result } = renderHook((x) => usePhotoDeletion(x), { initialProps: p })
    expect(result.current.trashItems).toHaveLength(3)

    await act(async () => {
      await result.current.purgeAll()
    })

    expect(stub.db.photos).toHaveLength(0)
    expect(stub.db.albums).toHaveLength(0)
    expect(texts().join('\n')).toMatch(/已彻底删除全部项目/)
  })
})

describe('回收站弹窗（TrashModal）', () => {
  it('点击「恢复」/「彻底删除」分别触发对应回调', async () => {
    const user = userEvent.setup()
    const onRestore = vi.fn()
    const onPurge = vi.fn()
    const items = [
      { id: 'p1', deletedAt: NOW, kind: 'photo' },
      { id: 'a1', deletedAt: NOW, kind: 'album' },
    ]
    render(
      <TrashModal
        open
        onClose={vi.fn()}
        items={items}
        days={30}
        renderItem={(it) => <span>{it.kind === 'photo' ? '一张照片' : '图集：旅行'}</span>}
        onRestore={onRestore}
        onPurge={onPurge}
      />,
    )

    expect(screen.getAllByText('↩ 恢复')).toHaveLength(2)
    await user.click(screen.getAllByText('↩ 恢复')[0])
    expect(onRestore).toHaveBeenCalledWith(items[0])

    await user.click(screen.getAllByText('彻底删除')[1])
    expect(onPurge).toHaveBeenCalledWith(items[1])
    // 剩余天数按传入的保留天数算
    expect(screen.getAllByText(/还剩 \d+ 天/).length).toBe(2)
  })

  it('空回收站显示空态文案，不显示清空按钮', () => {
    render(
      <TrashModal
        open
        onClose={vi.fn()}
        items={[]}
        days={30}
        renderItem={() => null}
        onRestore={vi.fn()}
        onPurge={vi.fn()}
        onPurgeAll={vi.fn()}
        emptyText="最近删除是空的"
      />,
    )
    expect(screen.getByText('最近删除是空的')).toBeInTheDocument()
    expect(screen.queryByText(/清空全部/)).toBeNull()
  })
})
