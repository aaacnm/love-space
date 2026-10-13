/**
 * 双方确认删除：一方发起申请 → 另一方点头 → 才真的删（软删进「最近删除」）。
 *
 * 这是全站唯一「一方动不了另一方数据」的链路，出错代价最大：
 * 要么照片被单方面删掉，要么审批成功了照片还在。这里把两条路都钉死。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { resetSupabase, sbApi, stub } from './helpers/supabase-stub-module.js'
import { getToastItems } from '../src/lib/toast.jsx'
import { usePhotoDeletion } from '../src/views/photos/usePhotoDeletion.js'

const NOW = '2026-10-13T00:00:00.000Z'
const texts = () => getToastItems().map((t) => t.text)

const photo = (over = {}) => ({
  id: 'p1',
  couple_id: 'c1',
  author_user_id: 'u2',
  storage_path: 'photos/c1/a.jpg',
  original_path: 'originals/c1/a.jpg',
  thumb_path: 'thumbs/c1/a.jpg',
  deleted_at: null,
  created_at: NOW,
  ...over,
})

const req = (over = {}) => ({
  id: 'r1',
  couple_id: 'c1',
  kind: 'photo',
  ref_ids: ['p1'],
  label: null,
  requester_user_id: 'u2', // TA 发起的
  status: 'pending',
  created_at: NOW,
  ...over,
})

function baseProps(over = {}) {
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
  resetSupabase({ db: { photos: [photo()], albums: [], delete_requests: [] } })
  globalThis.__TOAST__.clear()
})

/** 双人审批场景：库里躺着一条 TA 发来的待确认申请，页面同时拿到它 */
function withIncomingRequest(reqOver = {}, propsOver = {}) {
  const r = req(reqOver)
  resetSupabase({ db: { photos: [photo()], albums: [], delete_requests: [r] } })
  return baseProps({ reqRows: [r], ...propsOver })
}

describe('发起删除：双人空间必须等 TA 点头', () => {
  it('发起后只写一条 pending 申请，照片原地不动', async () => {
    const props = baseProps()
    const { result } = renderHook((p) => usePhotoDeletion(p), { initialProps: props })

    await act(async () => {
      await result.current.requestDelete({ kind: 'photo', ids: ['p1'] })
    })

    expect(stub.db.delete_requests).toHaveLength(1)
    const r = stub.db.delete_requests[0]
    expect(r.status).toBe('pending')
    expect(r.requester_user_id).toBe('u1')
    expect(r.ref_ids).toEqual(['p1'])
    // 关键：TA 还没点头，照片不能被删
    expect(stub.db.photos[0].deleted_at).toBe(null)
    expect(texts().join('\n')).toMatch(/已发给 TA/)
  })

  it('同一批照片已有待确认申请时不再重复发', async () => {
    resetSupabase({
      db: {
        photos: [photo()],
        albums: [],
        delete_requests: [req({ requester_user_id: 'u1', id: 'r0' })],
      },
    })
    const props = baseProps({ reqRows: stub.db.delete_requests })
    const { result } = renderHook((p) => usePhotoDeletion(p), { initialProps: props })

    await act(async () => {
      await result.current.requestDelete({ kind: 'photo', ids: ['p1'] })
    })

    expect(stub.db.delete_requests).toHaveLength(1)
    expect(texts().join('\n')).toMatch(/已经发给 TA|待确认条目/)
  })

  it('发起写库失败时如实提示，不让用户以为申请已发出', async () => {
    sbApi.failInsert('delete_requests', 'relation "delete_requests" does not exist')
    const props = baseProps()
    const { result } = renderHook((p) => usePhotoDeletion(p), { initialProps: props })

    await act(async () => {
      await result.current.requestDelete({ kind: 'photo', ids: ['p1'] })
    })

    expect(stub.db.delete_requests).toHaveLength(0)
    expect(texts().join('\n')).toMatch(/发起删除请求失败/)
    // 表都不存在时还要告诉用户去跑迁移
    expect(texts().join('\n')).toMatch(/migrations\/019_photo_delete/)
  })
})

describe('TA 点头：批准走事务 RPC', () => {
  it('同意后请求状态更新且照片软删进最近删除', async () => {
    const props = withIncomingRequest()
    // 模拟数据库事务：批准 + 软删原子完成
    sbApi.onRpc('approve_delete_request', async ({ p_request_id }) => {
      stub.db.delete_requests = stub.db.delete_requests.map((r) =>
        r.id === p_request_id ? { ...r, status: 'approved', resolved_at: NOW } : r,
      )
      stub.db.photos = stub.db.photos.map((p) =>
        p.id === 'p1' ? { ...p, deleted_at: NOW, deleted_by: 'u1' } : p,
      )
      return { data: null, error: null }
    })

    const { result, rerender } = renderHook((p) => usePhotoDeletion(p), { initialProps: props })
    // 对方发起的请求会自动进入待确认（reviewing）
    await waitFor(() => expect(result.current.reviewing?.id).toBe('r1'))
    expect(result.current.toReview).toHaveLength(1)

    await act(async () => {
      await result.current.respond(true)
    })

    // 唯一写入路径是 RPC：不存在「先 update 再软删」的两步写
    expect(stub.log.rpc.map((r) => r.name)).toEqual(['approve_delete_request'])
    expect(stub.log.rpc[0].args).toEqual({ p_request_id: 'r1' })
    expect(stub.log.update.filter((u) => u.table === 'delete_requests')).toHaveLength(0)
    expect(stub.db.photos[0].deleted_at).toBe(NOW)
    expect(stub.db.delete_requests[0].status).toBe('approved')
    expect(texts().join('\n')).toMatch(/已删除/)
    // 处理后刷新三张表
    expect(props.reload).toHaveBeenCalled()
    expect(props.reloadAlbums).toHaveBeenCalled()
    expect(props.reloadRequests).toHaveBeenCalled()
    rerender(props)
  })

  it('RPC 失败：提示 + 照片保持原状，且允许重试', async () => {
    const props = withIncomingRequest()
    sbApi.failRpc('approve_delete_request', 'function does not exist')
    const { result } = renderHook((p) => usePhotoDeletion(p), { initialProps: props })
    await waitFor(() => expect(result.current.reviewing?.id).toBe('r1'))

    await act(async () => {
      await result.current.respond(true)
    })

    expect(stub.db.photos[0].deleted_at).toBe(null)
    expect(stub.db.delete_requests[0].status).toBe('pending')
    const all = texts().join('\n')
    expect(all).toMatch(/批准失败/)
    expect(all).toMatch(/migrations\/031_delete_approve_rpc\.sql/)

    // 失败后解除注入，同样的请求可以再来一次
    sbApi.clearFailures()
    sbApi.onRpc('approve_delete_request', async () => {
      stub.db.photos = stub.db.photos.map((p) => ({ ...p, deleted_at: NOW }))
      return { data: null, error: null }
    })
    await act(async () => {
      await result.current.respond(true)
    })
    expect(stub.db.photos[0].deleted_at).toBe(NOW)
  })

  it('不同意：只改请求状态，照片毫发无损', async () => {
    const props = withIncomingRequest()
    const { result } = renderHook((p) => usePhotoDeletion(p), { initialProps: props })
    await waitFor(() => expect(result.current.reviewing?.id).toBe('r1'))

    await act(async () => {
      await result.current.respond(false)
    })

    expect(stub.db.delete_requests[0].status).toBe('rejected')
    expect(stub.db.delete_requests[0].responder_user_id).toBe('u1')
    expect(stub.db.photos[0].deleted_at).toBe(null)
    expect(stub.log.rpc).toHaveLength(0)
  })
})

describe('待确认条目：提醒只自动弹一次', () => {
  it('叉掉后不再自动弹出，但页面条目里还能重新打开', async () => {
    const props = withIncomingRequest()
    const { result, rerender } = renderHook((p) => usePhotoDeletion(p), { initialProps: props })
    await waitFor(() => expect(result.current.reviewing?.id).toBe('r1'))

    // 用户叉掉
    await act(async () => {
      result.current.setReviewing(null)
    })
    await waitFor(() => expect(result.current.reviewing).toBe(null))
    // 数据不变的情况下不会自己再弹出来
    rerender({ ...props })
    await waitFor(() => expect(result.current.reviewing).toBe(null))

    // 页面上「待你确认」的条目仍在（toReview 是渲染条目的数据源）
    expect(result.current.toReview).toHaveLength(1)
    // 手动重新打开
    await act(async () => {
      result.current.setReviewing(result.current.toReview[0])
    })
    expect(result.current.reviewing?.id).toBe('r1')
  })

  it('请求指向的照片已被删掉时自动作废', async () => {
    const props = baseProps({ reqRows: [req()], rows: [photo({ deleted_at: NOW })] })
    const { result } = renderHook((p) => usePhotoDeletion(p), { initialProps: props })

    expect(result.current.reqStale(req())).toBe(true)
    expect(result.current.toReview).toHaveLength(0)
    await waitFor(() => expect(result.current.reviewing).toBe(null))
  })

  it('撤回申请只删请求行，不动照片', async () => {
    const props = baseProps({ reqRows: [req({ requester_user_id: 'u1' })] })
    const { result } = renderHook((p) => usePhotoDeletion(p), { initialProps: props })

    await act(async () => {
      await result.current.revoke('r1')
    })

    expect(stub.db.delete_requests).toHaveLength(0)
    expect(stub.db.photos).toHaveLength(1)
    expect(props.reloadRequests).toHaveBeenCalled()
  })
})
