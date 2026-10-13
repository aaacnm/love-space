/**
 * 日记配图：入库失败必须撤回已上传的图片（P1）
 *
 * 修之前 Diary.submit 只 toast 一句「保存失败」，先传上去的配图留在 photos 桶里，
 * 既没人引用也删不掉 —— 孤儿文件。这里把「成功清理」和「清理失败也要说」两条都测掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { resetSupabase, sbApi, stub } from './helpers/supabase-stub-module.js'
import { getToastItems } from '../src/lib/toast.jsx'
import Diary from '../src/views/Diary.jsx'

// 空间上下文是全局单例，测试里替换成想要的用户/空间
const storeRef = vi.hoisted(() => ({ value: null }))
vi.mock('../src/lib/store.jsx', () => ({
  useStore: () => storeRef.value,
  StoreProvider: ({ children }) => children,
}))

// 压缩/保存依赖 canvas 与真实文件系统，这里直通
vi.mock('../src/lib/image.js', () => ({
  compressImage: async (file) => ({ file, before: 1000, after: 500 }),
  mapLimit: async (items, _n, fn) => {
    const out = []
    for (const it of items) out.push(await fn(it))
    return out
  },
  saveImage: async () => 'downloaded',
  downloadImages: async (list) => ({ saved: list.length, failed: 0 }),
}))

const texts = () => getToastItems().map((t) => t.text).join('\n')

beforeEach(() => {
  storeRef.value = {
    user: { id: 'u1' },
    coupleId: 'c1',
    partner: { user_id: 'u2' },
    members: [],
    couple: { id: 'c1' },
    loading: false,
    refresh: vi.fn(),
    enterSpace: vi.fn(),
    leaveSpace: vi.fn(),
  }
  resetSupabase({ db: { diary_entries: [] } })
  globalThis.__TOAST__.clear()
})

async function writeDiaryWithOneImage() {
  render(<Diary />)
  fireEvent.click(screen.getByText(/写日记/))
  const input = document.querySelector('input[type="file"]')
  fireEvent.change(input, { target: { files: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] } })
  // 压缩是异步的，等比按钮可用（files 已就位）
  await waitFor(() => expect(screen.getByText('保存日记')).toBeTruthy())
  await waitFor(() => expect(screen.getByText('保存日记').closest('button').disabled).toBe(false))
  fireEvent.click(screen.getByText('保存日记'))
}

describe('日记配图：入库失败不留孤儿文件', () => {
  it('入库失败：已上传的配图被撤回，提示里说明已清理', async () => {
    sbApi.failInsert('diary_entries', 'permission denied')
    await writeDiaryWithOneImage()
    await waitFor(() => expect(texts()).toMatch(/保存日记失败/))

    const removed = stub.log.remove.flatMap((r) => r.paths)
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatch(/^diary\/c1\/.+\.jpg$/) // 撤回的正是刚传的那张
    expect(texts()).toMatch(/已自动清理/)
    expect(texts()).not.toMatch(/孤儿文件/)
  })

  it('入库失败且删除也失败：提示里明确说出孤儿文件', async () => {
    sbApi.failInsert('diary_entries', 'permission denied')
    sbApi.failRemove('network down')
    await writeDiaryWithOneImage()
    await waitFor(() => expect(texts()).toMatch(/保存日记失败/))

    expect(stub.log.remove).toHaveLength(1) // 尝试过清理
    expect(texts()).toMatch(/孤儿文件/)
    expect(texts()).toMatch(/network down/)
  })

  it('一切顺利：不删任何文件，日记正常入库', async () => {
    await writeDiaryWithOneImage()
    await waitFor(() => expect(stub.db.diary_entries).toHaveLength(1))
    expect(stub.log.remove).toHaveLength(0)
    expect(stub.db.diary_entries[0].images[0]).toMatch(/^diary\/c1\/.+\.jpg$/)
  })
})
