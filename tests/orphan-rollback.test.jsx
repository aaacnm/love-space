/**
 * 孤儿文件：链路里任何一个「写库失败」都必须把已上传的文件撤回，且撤不回时要说出来。
 *
 * 之前的缺口：
 * · 日记配图入库失败只提示、不删文件（P1）；
 * · 留言图片/语音虽然 remove 了，但没检查 remove 的 error ——
 *   网络异常时文件还在桶里，用户却以为没事（P2）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { resetSupabase, sbApi, stub } from './helpers/supabase-stub-module.js'
import { getToastItems } from '../src/lib/toast.jsx'
import { removeUploads } from '../src/lib/storage.js'
import { useMessageActions } from '../src/views/messages/useMessageActions.js'

// 压缩依赖 canvas，测试里直通；被测目标是「上传 → 入库 → 撤回」的编排
vi.mock('../src/lib/image.js', () => ({
  compressImage: async (file) => ({ file, before: 1000, after: 500 }),
  saveImage: async () => 'downloaded',
  downloadImages: async (list) => ({ saved: list.length, failed: 0 }),
}))

const texts = () => getToastItems().map((t) => t.text).join('\n')
const imageFile = () => new File(['x'], 'a.jpg', { type: 'image/jpeg' })
const voiceBlob = () => new Blob(['abc'], { type: 'audio/wav' })

// messages 表在 stub 里需要有 voice_path / image_path 列可用（insert 直接放行）
function mountActions(over = {}) {
  const props = {
    coupleId: 'c1',
    user: { id: 'u1' },
    reactions: [],
    reloadReactions: vi.fn(),
    reloadHidden: vi.fn(),
    flagOf: vi.fn(),
    onSent: vi.fn(),
    ...over,
  }
  return renderHook(() => useMessageActions(props))
}

beforeEach(() => {
  resetSupabase({ db: { messages: [] } })
  globalThis.__TOAST__.clear()
})

describe('removeUploads：跨桶撤回原语', () => {
  it('去重并过滤空值，只发一次请求', async () => {
    await removeUploads('photos', ['a.jpg', 'a.jpg', 'b.jpg', null, undefined, ''])
    expect(stub.log.remove).toHaveLength(1)
    expect(stub.log.remove[0].paths).toEqual(['a.jpg', 'b.jpg'])
    expect(stub.log.remove[0].bucket).toBe('photos')
  })

  it('空列表不发起请求', async () => {
    expect(await removeUploads('photos', [])).toEqual({ error: null })
    expect(await removeUploads('voice', null)).toEqual({ error: null })
    expect(stub.log.remove).toHaveLength(0)
  })

  it('语音桶也能撤回（不再写死 photos）', async () => {
    await removeUploads('voice', ['c1/x.wav'])
    expect(stub.log.remove[0].bucket).toBe('voice')
  })

  it('撤回失败如实返回 error（调用方据此提示）', async () => {
    sbApi.failRemove('network down')
    const res = await removeUploads('photos', ['a.jpg'])
    expect(res.error).toEqual({ message: 'network down' })
  })
})

describe('留言图片：入库失败要撤回，撤不回要说出来', () => {
  it('入库失败：文件被删掉，不留孤儿', async () => {
    sbApi.failInsert('messages', 'permission denied')
    const { result } = mountActions()
    await act(async () => {
      await result.current.onPickImage({ target: { files: [imageFile()], value: '' } })
    })
    expect(stub.log.remove).toHaveLength(1)
    expect(stub.log.remove[0].paths[0]).toMatch(/^messages\/c1\//)
    expect(texts()).toMatch(/图片发送失败/)
    expect(texts()).not.toMatch(/孤儿文件/) // 清理成功了就别吓唬人
  })

  it('入库失败且删除也失败：提示里明确说明有孤儿文件', async () => {
    sbApi.failInsert('messages', 'permission denied')
    sbApi.failRemove('network down')
    const { result } = mountActions()
    await act(async () => {
      await result.current.onPickImage({ target: { files: [imageFile()], value: '' } })
    })
    expect(stub.log.remove).toHaveLength(1) // 尝试过删除
    expect(texts()).toMatch(/孤儿文件/) // 用户必须知道文件还在桶里
    expect(texts()).toMatch(/network down/)
  })
})

describe('留言语音：同上，撤的是 voice 桶', () => {
  it('入库失败：语音文件被删掉', async () => {
    sbApi.failInsert('messages', 'permission denied')
    const { result } = mountActions()
    await act(async () => {
      await result.current
        .sendVoice({ blob: voiceBlob(), seconds: 3, ext: 'wav' })
        .catch(() => {}) // 失败是预期：抛给弹窗处理
    })
    expect(stub.log.remove[0].bucket).toBe('voice')
    expect(stub.log.remove[0].paths[0]).toMatch(/^c1\/.+\.wav$/)
  })

  it('删除失败时抛出的错误里带孤儿文件说明', async () => {
    sbApi.failInsert('messages', 'permission denied')
    sbApi.failRemove('network down')
    const { result } = mountActions()
    let msg = ''
    await act(async () => {
      try {
        await result.current.sendVoice({ blob: voiceBlob(), seconds: 3, ext: 'wav' })
      } catch (e) {
        msg = e.message
      }
    })
    expect(msg).toMatch(/孤儿文件/)
    expect(msg).toMatch(/network down/)
  })

  it('全部成功：不删任何文件', async () => {
    const { result } = mountActions()
    await act(async () => {
      await result.current.sendVoice({ blob: voiceBlob(), seconds: 3, ext: 'wav' })
    })
    expect(stub.log.remove).toHaveLength(0)
    expect(stub.db.messages).toHaveLength(1)
  })
})
