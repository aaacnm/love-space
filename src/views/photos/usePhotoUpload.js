// 照片上传 + 保存到本机/相册：从 Photos.jsx 抽出的完整一块。
// 页面只负责把 UI 事件接进来，压缩、并发上传、入库失败回滚、iOS 逐张保存
// 这些细节都留在这里。
import { useRef, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { signedMediaUrl, signedMediaUrls, useSignedSrc } from '../../lib/storage.js'
import { toast } from '../../lib/toast.jsx'
import { compressImage, mapLimit, saveImage, downloadImages, isIOSDevice } from '../../lib/image.js'
import { uploadOne, rollbackUploads } from './upload.js'
import { MAX_PICK, UPLOAD_CONCURRENCY, PREVIEW_TF } from './constants.js'

export function usePhotoUpload({ coupleId, user, rows, active, reload }) {
  const fileRef = useRef(null)

  const [pending, setPending] = useState([]) // [{ orig, file(压缩后), url, before, after, thumb }]
  const [caption, setCaption] = useState('')
  const [uploadTo, setUploadTo] = useState('') // 目标图集 id，'' = 不分组
  const [saving, setSaving] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [progress, setProgress] = useState(null) // { done, total }
  const [hdMode, setHdMode] = useState(false) // true = 主图也用原图（慢但无损）
  const [keepOriginal, setKeepOriginal] = useState(true) // 额外存一份原图，供双方下载保存

  const [savingOne, setSavingOne] = useState(false)
  const [saveTip, setSaveTip] = useState('')
  const [batch, setBatch] = useState(null) // iOS 逐张保存队列 { items, index, saved, failed }
  const [batchBusy, setBatchBusy] = useState(false) // 当前一张正在保存
  const [savingBatch, setSavingBatch] = useState(null) // 安卓/电脑静默下载进度 { done, total }

  // 大图按需单签（contain 变换）：iOS 批量保存确认页展示当前这张
  const batchSrc = useSignedSrc('photos', batch?.items?.[batch.index]?.photo?.storage_path || null, PREVIEW_TF)

  const pickFiles = async (e) => {
    const picked = Array.from(e.target.files || []).slice(0, MAX_PICK - pending.length)
    e.target.value = ''
    if (picked.length === 0) return
    setPreparing(true)
    const items = await Promise.all(
      picked.map(async (file) => {
        const { file: small, before, after } = await compressImage(file)
        // 再压一张 480px 小缩略图：网格/封面用它，流量和解码时间都降一个数量级；失败不阻塞上传
        let thumb = null
        try {
          thumb = (await compressImage(file, { maxEdge: 480, quality: 0.7 })).file
        } catch {
          /* 压缩失败就用浏览图兜底 */
        }
        return {
          orig: file,
          file: small,
          url: URL.createObjectURL(small),
          before,
          after,
          thumb,
        }
      }),
    )
    setPending((prev) => [...prev, ...items])
    setPreparing(false)
  }

  const dropPending = (i) =>
    setPending((prev) => {
      const removed = prev[i]
      if (removed) URL.revokeObjectURL(removed.url)
      return prev.filter((_, idx) => idx !== i)
    })

  const clearPending = () =>
    setPending((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.url))
      return []
    })

  const openUpload = () => {
    setCaption('')
    setHdMode(false)
    setKeepOriginal(true)
    setUploadTo(active.kind === 'album' ? active.id : '')
  }

  const doUpload = async () => {
    if (pending.length === 0) return
    setSaving(true)
    setProgress({ done: 0, total: pending.length })

    // 并发上传（限制 3 条连接，既跑满带宽又不至于把免费层的连接占死）
    // 每张最多传三份：浏览用的压缩图 + 网格用的缩略图 + 供下载的原图
    const keepOrig = hdMode || keepOriginal
    const results = await mapLimit(pending, UPLOAD_CONCURRENCY, async (p) => {
      const main = hdMode ? p.orig : p.file
      const path = await uploadOne(coupleId, main)
      if (!path) return null

      let thumbPath = null
      if (p.thumb) {
        thumbPath = await uploadOne(coupleId, p.thumb, 'thumbs') // 失败返回 null，不阻塞
      }

      let originalPath = null
      if (keepOrig) {
        // 主图本身就是原图（勾了原图模式 / 压缩没生效）时，不必再传一份
        if (main === p.orig || p.after >= p.before) {
          originalPath = path
        } else {
          originalPath = await uploadOne(coupleId, p.orig, 'originals')
        }
      }

      setProgress((cur) => (cur ? { ...cur, done: cur.done + 1 } : cur))
      return { path, originalPath, thumbPath }
    })

    // 全部传完再一次性写库，比每张各写一次省掉一半网络往返
    const done = results.filter(Boolean)
    if (done.length > 0) {
      const payload = done.map(({ path, originalPath, thumbPath }) => ({
        couple_id: coupleId,
        author_user_id: user.id,
        storage_path: path,
        original_path: originalPath,
        thumb_path: thumbPath,
        caption: caption.trim() || null,
        album_id: uploadTo || null,
      }))
      // 本批所有已成功上传的文件路径（浏览图 + 原图 + 缩略图）——
      // 库一旦写不进去，这些文件全都会成为孤儿，统一撤回
      // （主图没传成的照片不会出现在 done 里，且它后续文件还没开始传，天然无残留）
      const uploadedPaths = done.flatMap((r) => [r.path, r.originalPath, r.thumbPath].filter(Boolean))
      let { error } = await supabase.from('photos').insert(payload)

      // 没跑对应迁移时，original_path / thumb_path 列不存在会让整批入库失败。
      // 这时去掉这两个字段重试一次，保证照片至少能正常显示（只是暂时没有原图/缩略图）。
      if (error && /original_path|thumb_path/i.test(error.message || '')) {
        const retry = await supabase
          .from('photos')
          // 有意丢掉这两个字段重试：解构出的变量不使用（eslint 的 rest 忽略只对声明生效）
          // eslint-disable-next-line no-unused-vars
          .insert(payload.map(({ original_path, thumb_path, ...rest }) => rest))
        if (!retry.error) {
          error = null
          toast.warning(
            '照片已上传 ✓\n\n不过还没执行 supabase/migrations/018_photo_original.sql / 024_photo_thumb.sql，这次没能保留原图、浏览也没用上缩略图。执行后新上传的照片就都齐了。',
          )
        } else {
          error = retry.error
        }
      }

      if (error) {
        // 入库失败：刚传上去的文件全部自动清理，不留孤儿；用户直接重传即可
        const rm = await rollbackUploads(uploadedPaths)
        toast.error(
          `照片传上去了，但保存记录失败，请直接重试。\n\n${
            rm.error
              ? // 清理没成功也要说：不然用户以为已经清干净，桶里实际还留着孤儿文件
                `注意：刚上传的文件这次没能删掉，会在存储里留下孤儿文件（原因：${rm.error.message}）。`
              : `刚上传的 ${done.length} 张照片文件已自动清理。`
          }\n\n原因：${error.message}`,
        )
      }
    }

    clearPending()
    setSaving(false)
    setProgress(null)
    setCaption('')
    if (done.length > 0) reload()
  }

  // 压缩前后总体积（上传确认弹窗展示「省了多少」）
  const totalBefore = pending.reduce((s, p) => s + p.before, 0)
  const totalAfter = pending.reduce((s, p) => s + p.after, 0)
  const compressed = totalBefore > 0 && totalAfter < totalBefore

  // 保存原图到本机 / 手机相册——对方上传的照片同样可以保存
  const saveCurrent = async (view) => {
    if (!view) return
    const path = view.original_path || view.storage_path
    const ext = (path.split('.').pop() || 'jpg').toLowerCase()
    const safe = (view.caption || 'photo').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 20)
    const name = `love_${safe}_${String(view.created_at).slice(0, 10)}.${ext}`
    setSavingOne(true)
    // 私有桶：先签 URL 再走保存流程
    const url = await signedMediaUrl('photos', path)
    const how = url ? await saveImage(url, name) : 'opened'
    setSavingOne(false)
    setSaveTip(
      how === 'shared'
        ? '已调起保存，在系统面板里选「存储到照片」即可 📱'
        : how === 'downloaded'
          ? '已开始下载，去「下载」里查看 💾'
          : '已在新标签打开，长按图片即可保存 🖼',
    )
    setTimeout(() => setSaveTip(''), 3500)
  }

  // ---------- 批量保存：和批量删除共用选择模式 ----------
  // 把选中项整理成 [{ path(原图优先), name, photo }]；文件名与单张保存同规则
  // （URL 在 batchSave 里按需批量签，避免每次渲染都签）
  const collectSaveItems = (ids) =>
    ids
      .map((id) => rows.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => {
        const path = p.original_path || p.storage_path
        const ext = (path.split('.').pop() || 'jpg').toLowerCase()
        const safe = (p.caption || 'photo').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 20)
        return { path, name: `love_${safe}_${String(p.created_at).slice(0, 10)}.${ext}`, photo: p }
      })

  const finishBatch = () => {
    setBatch(null)
    setBatchBusy(false)
  }

  const advanceBatch = (ok) => {
    setBatch((b) => (b ? { ...b, index: b.index + 1, saved: b.saved + (ok ? 1 : 0), failed: b.failed + (ok ? 0 : 1) } : b))
    setBatchBusy(false)
  }

  // selected 由页面传入（选择模式的选中项）；finishBatch 里一并清选择态的工作留给页面
  const batchSave = async (selected, onFinish) => {
    const items = collectSaveItems(selected)
    if (items.length === 0) return
    // 私有桶：先把要保存的文件一次性签好名，签不出的跳过
    const urls = await signedMediaUrls('photos', items.map((it) => it.path))
    const signed = items
      .map((it) => ({ ...it, url: urls.get(it.path) || '' }))
      .filter((it) => it.url)
    if (signed.length === 0) {
      toast.error('文件签名失败，稍后再试试 🔒')
      finishBatch()
      onFinish?.()
      return
    }
    if (isIOSDevice()) {
      // iOS：navigator.share 每次都要用户手势，静默循环会被系统拒绝。
      // 改成逐张确认弹窗——每张都由用户点按钮（真实手势）调起存储面板，能连续存进相册。
      setBatch({ items: signed, index: 0, saved: 0, failed: 0 })
      return
    }
    // Android / 电脑：静默逐张下载，不打扰
    setSavingBatch({ done: 0, total: signed.length })
    const { saved, failed } = await downloadImages(signed, ({ done, total }) => setSavingBatch({ done, total }))
    setSavingBatch(null)
    if (failed) toast.warning(`已保存 ${saved} 张，${failed} 张失败（网络波动，可重试）`)
    else toast.success(`已保存 ${saved} 张 💾 去相册/下载看看吧`)
    finishBatch()
    onFinish?.()
  }

  return {
    fileRef,
    pending,
    setPending,
    caption,
    setCaption,
    uploadTo,
    setUploadTo,
    saving,
    preparing,
    progress,
    hdMode,
    setHdMode,
    keepOriginal,
    setKeepOriginal,
    savingOne,
    saveTip,
    batch,
    setBatch,
    batchBusy,
    setBatchBusy,
    batchSrc,
    savingBatch,
    pickFiles,
    dropPending,
    clearPending,
    openUpload,
    doUpload,
    totalBefore,
    totalAfter,
    compressed,
    saveCurrent,
    collectSaveItems,
    finishBatch,
    advanceBatch,
    batchSave,
  }
}
