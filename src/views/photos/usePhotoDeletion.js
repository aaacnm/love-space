// 照片/图集的删除链路：一方发起 → 另一方点头 → 软删进「最近删除」→ 30 天后真删。
// 从 Photos.jsx 抽出。页面只拿结果去渲染，这里负责所有写库、回滚与提示。
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { toast } from '../../lib/toast.jsx'
import { PHOTO_TRASH_DAYS, isExpiredAt } from '../../lib/trash.js'

// 同批对象去重用：同一张照片/图集在另一个请求里也算
const overlapIds = (a, b) => (a || []).some((id) => (b || []).includes(id))

export function usePhotoDeletion({
  coupleId,
  user,
  rows,
  albums,
  reqRows,
  reload,
  reloadAlbums,
  reloadRequests,
  isSolo,
  onAlbumDeleted, // 图集被删掉后页面要跳回「未分组」
}) {
  const [reviewing, setReviewing] = useState(null) // 正在查看的删除请求（对方发起的）
  const [purgeConfirm, setPurgeConfirm] = useState(null) // 回收站里点了「彻底删除」的条目（真删不可恢复，再确认一次）
  const [purgeAllConfirm, setPurgeAllConfirm] = useState(false) // 一键清空最近删除（真删不可恢复，再确认一次）
  const [purgingAll, setPurgingAll] = useState(false) // 清空全部进行中

  const seenReqsRef = useRef(new Set()) // 已自动弹过提醒的请求 id：每个请求只自动弹一次，叉掉后从「待你确认」条目随时再打开
  const notifiedRef = useRef(new Set())
  const purgedRef = useRef(new Set())

  // ---------- 删除请求：一方发起，另一方点头 ----------
  const isMine = (r) => r.requester_user_id === user?.id
  const pendingReqs = reqRows.filter((r) => r.status === 'pending')

  // 请求已失效：指向的东西都已经删掉了（同意一条后，同一批东西的重复申请自动作废）
  const deletedPhotoIds = new Set(rows.filter((p) => p.deleted_at).map((p) => p.id))
  const deletedAlbumIds = new Set(albums.filter((a) => a.deleted_at).map((a) => a.id))
  const reqStale = (r) => {
    const ids = r.ref_ids || []
    if (ids.length === 0) return false
    const gone = r.kind === 'album' ? deletedAlbumIds : deletedPhotoIds
    return ids.every((id) => gone.has(id))
  }

  const toReview = pendingReqs.filter((r) => !isMine(r) && !reqStale(r))
  const myPending = pendingReqs.filter((r) => isMine(r) && !reqStale(r))
  const pendingPhotoIds = new Set(
    pendingReqs.filter((r) => r.kind === 'photo').flatMap((r) => r.ref_ids || []),
  )
  const pendingAlbumIds = new Set(
    pendingReqs.filter((r) => r.kind === 'album').flatMap((r) => r.ref_ids || []),
  )

  // 新请求自动弹一次提醒；叉掉后不重复弹（之前 respond 后旧列表还挂着 pending，
  // 会把刚处理完的请求再弹出来），可从页面上的「待你确认」条目随时重新打开
  useEffect(() => {
    if (reviewing) return
    const next = toReview.find((r) => !seenReqsRef.current.has(r.id))
    if (next) {
      seenReqsRef.current.add(next.id)
      setReviewing(next)
    }
  }, [toReview, reviewing])

  // 正在看的请求被撤回/失效（指向的东西已经删掉）时自动关掉确认弹窗
  useEffect(() => {
    if (reviewing && (!pendingReqs.some((r) => r.id === reviewing.id) || reqStale(reviewing))) {
      setReviewing(null)
    }
  }, [pendingReqs, reviewing])

  // TA 不同意 → 告诉发起者一声
  useEffect(() => {
    reqRows.forEach((r) => {
      if (!isMine(r) || r.status !== 'rejected' || notifiedRef.current.has(r.id)) return
      notifiedRef.current.add(r.id)
      const what = r.kind === 'album' ? `图集「${r.label || ''}」` : `${(r.ref_ids || []).length} 张照片`
      toast.warning(`TA 不同意删除${what}，这次就不删了`)
    })
  }, [reqRows])

  // ---------- 最近删除：满 30 天自动清掉 ----------
  const trashItems = [
    ...rows
      .filter((p) => p.deleted_at && !isExpiredAt(p.deleted_at, PHOTO_TRASH_DAYS))
      .map((p) => ({ id: p.id, deletedAt: p.deleted_at, kind: 'photo', photo: p })),
    ...albums
      .filter((a) => a.deleted_at && !isExpiredAt(a.deleted_at, PHOTO_TRASH_DAYS))
      .map((a) => ({ id: a.id, deletedAt: a.deleted_at, kind: 'album', album: a })),
  ].sort((x, y) => new Date(y.deletedAt) - new Date(x.deletedAt))

  // 懒清理：打开界面时把过期的真删掉（照片连文件一起删）
  useEffect(() => {
    const expiredPhotos = rows.filter((p) => p.deleted_at && isExpiredAt(p.deleted_at, PHOTO_TRASH_DAYS))
    const expiredAlbums = albums.filter((a) => a.deleted_at && isExpiredAt(a.deleted_at, PHOTO_TRASH_DAYS))
    if (expiredPhotos.length === 0 && expiredAlbums.length === 0) return
    let cancelled = false
    const run = async () => {
      for (const p of expiredPhotos) {
        if (purgedRef.current.has(p.id)) continue
        purgedRef.current.add(p.id)
        await supabase.from('photos').delete().eq('id', p.id)
        // 三份文件一起清：浏览图 + 原图 + 缩略图（漏了 thumb_path 会留孤儿文件）
        const files = [...new Set([p.storage_path, p.original_path, p.thumb_path].filter(Boolean))]
        if (files.length) await supabase.storage.from('photos').remove(files)
      }
      for (const a of expiredAlbums) {
        if (purgedRef.current.has(a.id)) continue
        purgedRef.current.add(a.id)
        await supabase.from('albums').delete().eq('id', a.id)
      }
      if (!cancelled) {
        reload()
        reloadAlbums()
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [rows, albums])

  // 同意：一律软删除，进「最近删除」躺 30 天（彻底删除不在这里——那是回收站里的个人操作）
  // 软删除：返回失败清单（空数组 = 全部成功）。供单人空间直删使用；
  // 双人空间的批准路径已改走 RPC 事务，不再经过这里。
  const softDelete = async (req) => {
    const nowIso = new Date().toISOString()
    const errs = []
    if (req.kind === 'album') {
      for (const id of req.ref_ids || []) {
        const rm = await supabase.from('photos').update({ album_id: null }).eq('album_id', id)
        if (rm.error) errs.push('照片移出图集失败：' + rm.error.message)
        const mv = await supabase.from('albums').update({ deleted_at: nowIso, deleted_by: user.id }).eq('id', id)
        if (mv.error) errs.push('图集删除失败：' + mv.error.message)
      }
    } else {
      const { error } = await supabase
        .from('photos')
        .update({ deleted_at: nowIso, deleted_by: user.id })
        .in('id', req.ref_ids || [])
      if (error) errs.push(error.message)
    }
    return errs
  }

  const requestDelete = async ({ kind, ids, label }) => {
    if (!ids || ids.length === 0) return
    // 单人空间：没有 TA 可以点头，直接软删除进「最近删除」（30 天内可自行恢复）
    if (isSolo) {
      const errs = await softDelete({ kind, ref_ids: ids })
      if (errs.length > 0) {
        // 删除没生效就如实说，别让用户以为删掉了
        toast.error('删除失败：' + errs[0] + '\n\n照片没有被改动，请重试')
        return
      }
      if (kind === 'album') onAlbumDeleted?.()
      toast.success('空间里暂时只有你一个人，无需审核，已直接删除 ✓（可在「最近删除」找回，保留 30 天）')
      reload()
      reloadAlbums()
      return
    }
    // 防重：同一批东西已经有待确认的申请时不再发（不然 TA 那边会挂出好几条一样的）
    const dup = pendingReqs.find((r) => r.kind === kind && overlapIds(r.ref_ids, ids) && !reqStale(r))
    if (dup) {
      toast.warning(
        isMine(dup)
          ? '这个删除申请已经发给 TA 了，等 TA 确认就好 ⏳'
          : 'TA 已经发起过这个删除申请，在上方待确认条目里处理即可',
      )
      return
    }
    const { error } = await supabase.from('delete_requests').insert({
      couple_id: coupleId,
      kind,
      ref_ids: ids,
      label: label || null,
      requester_user_id: user.id,
      status: 'pending',
    })
    if (error) {
      toast.error('发起删除请求失败：' + error.message)
      if (/delete_requests|relation/i.test(error.message || '')) {
        toast.warning('还没有执行 supabase/migrations/019_photo_delete.sql，请在 Supabase 的 SQL Editor 里跑一下')
      }
      return
    }
    toast.success('已发给 TA，等 TA 同意后才会删除 ⏳')
    reloadRequests()
  }

  const respond = async (approve) => {
    const req = reviewing
    if (!req) return
    seenReqsRef.current.add(req.id)
    // 同一批对象的其他待确认请求一并标记：同意/拒绝一条后，其余的不再自动弹出
    pendingReqs.forEach((r) => {
      if (r.id !== req.id && r.status === 'pending' && r.kind === req.kind && overlapIds(r.ref_ids, req.ref_ids)) {
        seenReqsRef.current.add(r.id)
      }
    })
    if (approve) {
      // 批准走数据库事务 RPC：批准 + 软删除 + 更新状态原子完成，
      // 不会出现「请求已同意、照片却还在」的中间态（软删除失败会整体回滚）
      const { error: rpcError } = await supabase.rpc('approve_delete_request', { p_request_id: req.id })
      if (rpcError) {
        toast.error('批准失败：' + rpcError.message)
        if (/function|approve_delete_request/i.test(rpcError.message || '')) {
          toast.warning('还没有执行 supabase/migrations/031_delete_approve_rpc.sql，请在 Supabase 的 SQL Editor 里跑一下')
        }
        seenReqsRef.current.delete(req.id) // 失败了允许下次重新弹出让 TA 再试
        return
      }
      if (req.kind === 'album') onAlbumDeleted?.()
      toast.success('已删除 ✓')
    } else {
      // 拒绝只改请求状态，不动任何数据
      const { error } = await supabase
        .from('delete_requests')
        .update({
          status: 'rejected',
          responder_user_id: user.id,
          resolved_at: new Date().toISOString(),
        })
        .eq('id', req.id)
      if (error) {
        toast.error('操作失败：' + error.message)
        seenReqsRef.current.delete(req.id)
        return
      }
    }
    setReviewing(null)
    reload()
    reloadAlbums()
    reloadRequests()
  }

  const revoke = async (id) => {
    const { error } = await supabase.from('delete_requests').delete().eq('id', id)
    if (error) {
      toast.error('撤回失败：' + error.message)
      return
    }
    reloadRequests()
  }

  // 从最近删除捞回来（恢复不需要对方同意）
  const restoreItem = async (item) => {
    const { error } =
      item.kind === 'photo'
        ? await supabase.from('photos').update({ deleted_at: null, deleted_by: null }).eq('id', item.id)
        : await supabase.from('albums').update({ deleted_at: null, deleted_by: null }).eq('id', item.id)
    if (error) {
      toast.error('恢复失败：' + error.message)
      return
    }
    if (item.kind !== 'photo') {
      toast.success('图集恢复了，不过里面的照片现在在「未分组」，可以重新拖回去')
    }
    reload()
    reloadAlbums()
  }

  // 彻底删除是个人行为：真删行和文件，不可恢复（回收站里点「彻底删除」后先弹确认）
  // 删完保持回收站弹窗打开，继续处理剩下的条目
  const purgeItem = async (item) => {
    if (item.kind === 'photo') {
      // 先删记录再删文件：记录删掉后文件最多成孤儿（可由诊断 SQL 兜底），
      // 反过来先删文件会让记录指向不存在的文件，前端加载直接 404
      const { error: rowErr } = await supabase.from('photos').delete().eq('id', item.id)
      if (rowErr) {
        toast.error('彻底删除失败：' + rowErr.message + '\n\n照片还在最近删除里，可以直接重试')
        return
      }
      const files = [...new Set([item.photo.storage_path, item.photo.original_path, item.photo.thumb_path].filter(Boolean))]
      if (files.length) {
        const { error: fileErr } = await supabase.storage.from('photos').remove(files)
        if (fileErr) toast.warning('照片记录已删除，但文件清理失败（' + fileErr.message + '），不影响使用')
      }
    } else {
      const { error } = await supabase.from('albums').delete().eq('id', item.id)
      if (error) {
        toast.error('彻底删除失败：' + error.message + '\n\n图集还在最近删除里，可以直接重试')
        return
      }
    }
    reload()
    reloadAlbums()
  }

  // 一键清空：真删最近删除里的全部条目（含原图文件），不可恢复
  const purgeAll = async () => {
    if (purgingAll) return
    setPurgingAll(true)
    let failed = 0
    try {
      for (const item of trashItems) {
        if (purgedRef.current.has(item.id)) continue
        purgedRef.current.add(item.id)
        if (item.kind === 'photo') {
          const { error: rowErr } = await supabase.from('photos').delete().eq('id', item.id)
          if (rowErr) {
            purgedRef.current.delete(item.id) // 没删成的允许重试
            failed++
            continue
          }
          const files = [...new Set([item.photo.storage_path, item.photo.original_path, item.photo.thumb_path].filter(Boolean))]
          if (files.length) {
            const { error: fileErr } = await supabase.storage.from('photos').remove(files)
            if (fileErr) console.error('文件清理失败（记录已删）：', fileErr.message)
          }
        } else {
          const { error } = await supabase.from('albums').delete().eq('id', item.id)
          if (error) {
            purgedRef.current.delete(item.id)
            failed++
            continue
          }
        }
      }
    } finally {
      setPurgingAll(false)
    }
    reload()
    reloadAlbums()
    if (failed > 0) {
      toast.warning(`已删除 ${trashItems.length - failed} 项，${failed} 项失败（还在列表里，可重试）`)
    } else {
      toast.success('已彻底删除全部项目 ✓')
    }
  }

  return {
    isMine,
    pendingReqs,
    reqStale,
    toReview,
    myPending,
    pendingPhotoIds,
    pendingAlbumIds,
    reviewing,
    setReviewing,
    trashItems,
    requestDelete,
    softDelete,
    respond,
    revoke,
    restoreItem,
    purgeItem,
    purgeAll,
    purgeConfirm,
    setPurgeConfirm,
    purgeAllConfirm,
    setPurgeAllConfirm,
    purgingAll,
  }
}
