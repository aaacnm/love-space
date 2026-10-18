// 图集的派生数据 / 增删改 / 归类，以及「记忆空间」三件套（置顶、随机回忆、导出）。
// 从 Photos.jsx 抽出：页面与子组件都从这里拿数据，不再各自 filter / sort。
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { signedMediaUrls } from '../../lib/storage.js'
import { useViewerSrcs } from '../../lib/mediaUrls.js'
import { toast } from '../../lib/toast.jsx'
import { fmtMonth, fmtFullDate, loadBrowse, saveBrowse } from './constants.js'
import { columnsOf } from '../../lib/tableColumns.js'

// ---------- 图集：派生数据 + 增删改 + 归类 ----------
export function useAlbums({ coupleId, rows, albums, reload, reloadAlbums, active, onCreatedAlbum, onSelectDone }) {
  // 软删除的不算数：界面只看还在的，删掉的去「最近删除」
  const livePhotos = rows.filter((p) => !p.deleted_at)
  const liveAlbums = albums.filter((a) => !a.deleted_at)
  const unfiled = livePhotos.filter((p) => !p.album_id)
  const inAlbum = (id) => livePhotos.filter((p) => p.album_id === id)
  const list = active.kind === 'unfiled' ? unfiled : inAlbum(active.id)

  // 网格排序：置顶的照片浮到最前（置顶是情侣共同状态，双方一致），其余保持新→旧
  const pinnedFirst = (arr) => [...arr].sort((a, b) => (b.pinned_at ? 1 : 0) - (a.pinned_at ? 1 : 0))

  // 图集封面自动生成：置顶的照片优先（最近置顶的），否则用最新一张
  const coverOf = (id) => {
    const arr = inAlbum(id)
    const pinned = arr
      .filter((p) => p.pinned_at)
      .sort((a, b) => new Date(b.pinned_at) - new Date(a.pinned_at))
    return pinned[0] || arr[0]
  }
  // 图集时间范围：最早一张 ~ 最近一张
  const rangeOf = (id) => {
    const arr = inAlbum(id)
    if (arr.length === 0) return null
    let min = arr[0]
    let max = arr[0]
    for (const p of arr) {
      if (p.created_at < min.created_at) min = p
      if (p.created_at > max.created_at) max = p
    }
    return { min: min.created_at, max: max.created_at, count: arr.length }
  }
  // 时间线分组：按「年-月」聚簇（忽略置顶顺序，纯时间轴）
  const timelineGroups = (() => {
    const chrono = [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    const groups = []
    for (const p of chrono) {
      const d = new Date(p.created_at)
      const key = `${d.getFullYear()}-${d.getMonth()}`
      const last = groups[groups.length - 1]
      if (last && last.key === key) last.items.push(p)
      else groups.push({ key, y: d.getFullYear(), m: d.getMonth() + 1, items: [p] })
    }
    return groups
  })()

  const [albumName, setAlbumName] = useState('')
  const [newAlbumOpen, setNewAlbumOpen] = useState(false)
  const [renaming, setRenaming] = useState(null) // album 对象
  const [moveOpen, setMoveOpen] = useState(false)

  // ---------- 图集 CRUD ----------
  const createAlbum = async () => {
    const name = albumName.trim()
    if (!name) return
    const { data, error } = await supabase
      .from('albums')
      .insert({ couple_id: coupleId, name })
      .select()
      .single()
    if (error) toast.error('创建图集失败：' + error.message)
    else {
      setAlbumName('')
      setNewAlbumOpen(false)
      reloadAlbums()
      onCreatedAlbum?.(data.id)
    }
  }

  // 编辑图集：名字 + 简介（记忆空间的「说明牌」）
  const saveAlbumInfo = async () => {
    const name = (renaming?.name || '').trim()
    if (!name) return
    const { error } = await supabase
      .from('albums')
      .update({ name, description: (renaming.description || '').trim() || null })
      .eq('id', renaming.id)
    if (error) toast.error('保存图集信息失败：' + error.message)
    else {
      setRenaming(null)
      reloadAlbums()
    }
  }

  // 归类：多选 / 拖拽共用
  const applyAlbum = async (ids, albumId, { closeSelect = true } = {}) => {
    const { error } = await supabase.from('photos').update({ album_id: albumId || null }).in('id', ids)
    if (error) toast.error('移动失败：' + error.message)
    else reload()
    if (closeSelect) onSelectDone?.()
    setMoveOpen(false)
  }

  return {
    livePhotos,
    liveAlbums,
    unfiled,
    inAlbum,
    list,
    pinnedFirst,
    coverOf,
    rangeOf,
    timelineGroups,
    albumName,
    setAlbumName,
    newAlbumOpen,
    setNewAlbumOpen,
    renaming,
    setRenaming,
    moveOpen,
    setMoveOpen,
    createAlbum,
    saveAlbumInfo,
    applyAlbum,
  }
}

// ---------- 记忆空间：浏览方式 / 置顶 / 随机回忆 / 导出 ----------
export function usePhotoMemory({ coupleId, uid, rows, livePhotos, memberMap, rangeOf, onPinned }) {
  // 浏览方式（网格/时间线，按 userId+coupleId 隔离）、随机回忆、图集导出进度
  const [browseMode, setBrowseMode] = useState(() => loadBrowse(uid, coupleId))
  const [memory, setMemory] = useState(null) // 随机回忆正在展示的照片
  const [exporting, setExporting] = useState(null) // { done, total } 打包进度

  // 随机回忆是「一屏一张」的大图：同样给 1280 + 未变换两档，按屏幕挑
  const memoryViewer = useViewerSrcs('photos', memory?.storage_path || null)

  // 换账号/换空间时重新播种浏览方式（先于保存 effect 声明，避免把旧空间的模式写进新 key）
  useEffect(() => {
    setBrowseMode(loadBrowse(uid, coupleId))
  }, [uid, coupleId])
  // 浏览方式变化时持久化到当前账号当前空间
  useEffect(() => {
    saveBrowse(uid, coupleId, browseMode)
  }, [browseMode])

  // 置顶 / 取消置顶：情侣共同状态——pinned_at 存在照片上，双方看到的置顶效果一致
  // （排最前 + 优先当图集封面；只会触发 UPDATE，不触发推送/横幅）
  const togglePin = async (p) => {
    const next = p.pinned_at ? null : new Date().toISOString()
    const { error } = await supabase.from('photos').update({ pinned_at: next }).eq('id', p.id)
    if (error) {
      if (/pinned_at/i.test(error.message || '')) {
        toast.warning('还没有执行 supabase/migrations/029_photos_memory_pin.sql（置顶字段），请在 SQL Editor 里跑一下')
      } else {
        toast.error('置顶失败：' + error.message)
      }
      return
    }
    // 大图弹窗开着的话同步按钮状态
    onPinned?.(p.id, next)
  }

  // 随机回忆：从全部照片里抽一张（避免和当前展示的重复）
  const rollMemory = () => {
    if (livePhotos.length === 0) {
      toast.warning('相册还空着，先传几张照片，回忆才有得冒泡 🎞')
      return
    }
    let pick = livePhotos[Math.floor(Math.random() * livePhotos.length)]
    while (memory && livePhotos.length > 1 && pick.id === memory.id) {
      pick = livePhotos[Math.floor(Math.random() * livePhotos.length)]
    }
    setMemory(pick)
  }

  // 导出图集：原图打包成 zip 下载，附 README（简介 / 时间范围 / 照片清单）
  const exportAlbum = async (album) => {
    if (exporting) return
    // 分页改造后 rows 只含已加载页——导出是「要全量」的重操作，
    // 触发时按图集单独拉一次完整清单（失败退回已加载范围，不 block 导出）
    let photos = []
    {
      const { data, error } = await supabase
        .from('photos')
        // 导出要的是清单而不是原图数据：同样只取列表字段（lib/tableColumns.js）
        .select(columnsOf('photos'))
        .eq('couple_id', coupleId)
        .eq('album_id', album.id)
        .is('deleted_at', null)
      photos = error || !data ? rows.filter((p) => p.album_id === album.id && !p.deleted_at) : data
    }
    photos = [...photos].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    if (photos.length === 0) {
      toast.warning('这个图集还没有照片，导不出东西 📦')
      return
    }
    setExporting({ done: 0, total: photos.length })
    try {
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      // 私有桶：整批原图先签好名（一次请求），再逐张下载
      const urls = await signedMediaUrls('photos', photos.map((p) => p.original_path || p.storage_path))
      const manifest = []
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i]
        const path = p.original_path || p.storage_path
        const url = urls.get(path)
        if (!url) throw new Error(`第 ${i + 1} 张签名失败`)
        const res = await fetch(url)
        if (!res.ok) throw new Error(`第 ${i + 1} 张下载失败（HTTP ${res.status}）`)
        const blob = await res.blob()
        const ext = (path.split('.').pop() || 'jpg').toLowerCase()
        const safeCap = (p.caption || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 20)
        const name = `${String(i + 1).padStart(2, '0')}_${String(p.created_at).slice(0, 10)}${safeCap ? `_${safeCap}` : ''}.${ext}`
        zip.file(`photos/${name}`, blob)
        manifest.push(
          `${name}  ${fmtFullDate(p.created_at)}  ${p.caption || ''}（${memberMap[p.author_user_id]?.nickname || 'TA'} 上传）`,
        )
        setExporting({ done: i + 1, total: photos.length })
      }
      const range = rangeOf(album.id)
      zip.file(
        'README.txt',
        [
          `图集：${album.name}`,
          album.description ? `简介：${album.description}` : null,
          range ? `时间范围：${fmtMonth(range.min)} - ${fmtMonth(range.max)}，共 ${photos.length} 张` : null,
          `导出时间：${new Date().toLocaleString()}`,
          '',
          '照片清单：',
          ...manifest,
        ]
          .filter((x) => x !== null)
          .join('\n'),
      )
      const bundle = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(bundle)
      const a = document.createElement('a')
      a.href = url
      a.download = `${album.name}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      toast.success('图集已打包完成，开始下载 📦')
    } catch (err) {
      toast.error('导出失败：' + ((err && err.message) || err))
    } finally {
      setExporting(null)
    }
  }

  return {
    browseMode,
    setBrowseMode,
    memory,
    setMemory,
    memoryViewer,
    exporting,
    togglePin,
    rollMemory,
    exportAlbum,
  }
}
