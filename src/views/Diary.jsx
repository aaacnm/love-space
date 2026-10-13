import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store.jsx'
import { supabase } from '../lib/supabase.js'
import { useCollection, usePagedCollection, MOODS, formatDateTime, todayStr } from '../lib/hooks.js'
import { Card, Button, Modal, TextArea, EmptyState, Spinner, SectionTitle, ConfirmModal } from '../components/ui.jsx'
import { Avatar } from '../components/Avatar.jsx'
import TrashModal from '../components/TrashModal.jsx'
import { compressImage, mapLimit } from '../lib/image.js'
import SmartImg from '../components/SmartImg.jsx'
import { useSignedMap, useSignedSrc, removeUploads } from '../lib/storage.js'
import { isExpiredAt } from '../lib/trash.js'
import { useToast } from '../lib/toast.jsx'
import LoadMore from '../components/LoadMore.jsx'

const moodEmoji = (v) => MOODS.find((m) => m.value === v)?.emoji || '😊'
// photos 桶已转私有：日记配图走签名 URL（lib/storage.js）。
// 缩略网格直接签真实文件 + CSS object-cover 裁切（等比裁剪不变形）；
// 灯箱大图按需单签 + contain 变换（等比适配、不放大、不把原图怼进手机流量）
const PREVIEW_TF = { height: 1280, resize: 'contain' }
const MAX_IMAGES = 3
const imgsOf = (d) => (Array.isArray(d.images) ? d.images : [])

// 本地时区的 YYYY-MM / YYYY-MM-DD（created_at 是 UTC，直接 toISOString 会差 8 小时）
const monthKey = (iso) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const dayKey = (iso) => {
  const d = new Date(iso)
  return `${monthKey(iso)}-${String(d.getDate()).padStart(2, '0')}`
}
const monthLabel = (key) => {
  const [y, m] = key.split('-')
  return Number(m) === new Date().getMonth() + 1 && Number(y) === new Date().getFullYear()
    ? '本月'
    : `${y}年${Number(m)}月`
}

export default function Diary() {
  const { coupleId, user, members } = useStore()
  const toast = useToast() // 统一提示：所有 Supabase 操作的成功/失败都经过它
  // 主日记流分页：首屏最近 30 条，滚动到底加载更早的
  const { rows, loading, loadingMore, hasMore, loadMore, reload } = usePagedCollection('diary_entries', coupleId, {
    orderBy: 'created_at',
    ascending: false,
  })
  const { rows: comments } = useCollection('diary_comments', coupleId, { orderBy: 'created_at', ascending: true })
  const { rows: hiddenRows, reload: reloadHidden } = useCollection('diary_hidden', coupleId)

  const fileRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [pendingPurge, setPendingPurge] = useState(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [viewing, setViewing] = useState(null)
  const [lightbox, setLightbox] = useState(null)
  const [content, setContent] = useState('')
  const [mood, setMood] = useState('开心')
  const [files, setFiles] = useState([]) // [{ file, url }]
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [month, setMonth] = useState('all') // 'all' 或 'YYYY-MM'
  const [day, setDay] = useState(todayStr()) // 'YYYY-MM-DD'，优先于月份；默认今天（iOS 空值会显示白块）

  // ---------- 私有桶签名 URL（photos 桶，日记配图一次批量签，内存缓存） ----------
  const imgSrcs = useSignedMap('photos', rows.flatMap((d) => imgsOf(d)))
  // 灯箱大图按需单签 + contain 变换
  const lightboxSrc = useSignedSrc('photos', lightbox, PREVIEW_TF)

  const memberMap = Object.fromEntries(members.map((m) => [m.user_id, m]))
  // 软删除（deleted_at 非空）的不算在正文列表里，它们归「最近删除」管
  const live = rows.filter((d) => !d.deleted_at)
  const hiddenIds = new Set(hiddenRows.filter((h) => h.user_id === user?.id).map((h) => h.diary_id))
  const visible = live.filter((d) => !hiddenIds.has(d.id))
  const hiddenList = live.filter((d) => hiddenIds.has(d.id))
  const commentsOf = (id) => comments.filter((c) => c.diary_id === id)

  // 最近删除：直接从日记自身的 deleted_at 推导，不依赖额外的回收站表
  const trashItems = rows
    .filter((d) => d.deleted_at && !isExpiredAt(d.deleted_at))
    .map((d) => ({ id: d.id, deletedAt: d.deleted_at, d }))

  // 日期筛选：先按月，选了具体某天则以天为准
  const months = [...new Set(visible.map((d) => monthKey(d.created_at)))].sort().reverse()
  const countByMonth = (m) => visible.filter((d) => monthKey(d.created_at) === m).length
  const matchFilter = (d) => (day ? dayKey(d.created_at) === day : month === 'all' || monthKey(d.created_at) === month)
  const filtered = visible.filter(matchFilter)
  const filterActive = day !== '' || month !== 'all'

  // 正在看的日记被对方删除后，实时推送到达时自动关掉弹窗，避免停留在空内容上
  useEffect(() => {
    if (viewing && !rows.some((d) => d.id === viewing.id)) {
      setViewing(null)
      setDraft('')
    }
  }, [rows, viewing])

  // 过期自动清除：deleted_at 超过 3 天的日记就真删掉（配图一起清）
  const purgedRef = useRef(new Set())
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      for (const d of rows) {
        if (!d.deleted_at || !isExpiredAt(d.deleted_at) || purgedRef.current.has(d.id)) continue
        purgedRef.current.add(d.id)
        const { error } = await supabase.from('diary_entries').delete().eq('id', d.id)
        if (!error) {
          const imgs = imgsOf(d)
          if (imgs.length) await supabase.storage.from('photos').remove(imgs)
        } else {
          toast.error('清除过期日记失败：' + error.message)
        }
      }
      if (!cancelled) reload()
    }
    if (rows.some((d) => d.deleted_at && isExpiredAt(d.deleted_at))) run()
    return () => {
      cancelled = true
    }
  }, [rows])

  // ---- 写日记 ----

  const pickImages = async (e) => {
    const picked = Array.from(e.target.files || []).slice(0, MAX_IMAGES - files.length)
    e.target.value = ''
    if (picked.length === 0) return
    setFiles((prev) => [
      ...prev,
      // 先占位（用原图预览），压缩完再替换 file，避免等待时看不到图
      ...picked.map((file) => ({ file, url: URL.createObjectURL(file) })),
    ])
    const compressed = await Promise.all(picked.map((file) => compressImage(file)))
    setFiles((prev) => {
      const map = new Map(picked.map((f, i) => [f, compressed[i].file]))
      return prev.map((f) => (map.has(f.file) ? { ...f, file: map.get(f.file) } : f))
    })
  }

  const resetForm = () => {
    setContent('')
    setMood('开心')
    setFiles([])
  }

  const submit = async () => {
    if (!content.trim() && files.length === 0) return
    setSaving(true)

    // 并发上传 + 压缩后的图，比串行传原图快一个数量级
    const paths = (
      await mapLimit(
        files,
        3,
        async (f) => {
          const ext = f.file.type === 'image/png' ? 'png' : 'jpg'
          const path = `diary/${coupleId}/${crypto.randomUUID()}.${ext}`
          const { error } = await supabase.storage.from('photos').upload(path, f.file, {
            cacheControl: '31536000',
            contentType: f.file.type || 'image/jpeg',
            upsert: false,
          })
          if (error) {
            toast.error('日记配图上传失败：' + error.message)
            return null
          }
          return path
        },
      )
    ).filter(Boolean)

    const { error } = await supabase.from('diary_entries').insert({
      couple_id: coupleId,
      author_user_id: user.id,
      content: content.trim() || '（只有图片）',
      mood,
      images: paths,
    })
    setSaving(false)
    if (!error) {
      resetForm()
      setOpen(false)
      // 清掉日期筛选，否则正看着历史月份时新日记会被过滤挡住、以为没保存成功
      setMonth('all')
      setDay('')
      reload()
    } else {
      // 入库失败：已经传上去的配图必须撤回，否则桶里永远留着没人引用的孤儿文件
      const rm = await removeUploads('photos', paths)
      toast.error(
        '保存日记失败：' +
          error.message +
          (rm.error
            ? // 清理没成功也要说，别让用户以为文件已经清干净了
              `\n\n另外，已上传的 ${paths.length} 张配图没能删掉，会在存储里留下孤儿文件（原因：${rm.error.message}）。`
            : paths.length
              ? `\n\n已上传的 ${paths.length} 张配图已自动清理，可直接重试。`
              : ''),
      )
    }
  }

  // ---- 删除（只能删自己的） ----

  // 软删除：打上 deleted_at 记一笔进回收站，3 天内还能回来
  const remove = async (id) => {
    const { error } = await supabase
      .from('diary_entries')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
    if (error) {
      toast.error('删除日记失败：' + error.message)
    } else {
      reload()
      setViewing(null)
    }
    setPendingDelete(null)
  }

  // 从最近删除里捞回来（评论也还在）
  const restore = async (d) => {
    const { error } = await supabase.from('diary_entries').update({ deleted_at: null }).eq('id', d.id)
    if (error) toast.error('恢复日记失败：' + error.message)
    reload()
  }

  // 提前彻底删除：日记行 + 配图一起清掉
  const purge = async (item) => {
    if (!item) return
    const { error } = await supabase.from('diary_entries').delete().eq('id', item.d.id)
    if (error) {
      toast.error('彻底删除失败：' + error.message)
    } else {
      const imgs = imgsOf(item.d)
      if (imgs.length) await supabase.storage.from('photos').remove(imgs)
    }
    reload()
    setPendingPurge(null)
  }

  // ---- 各自独立隐藏 ----

  const toggleHide = async (d) => {
    if (hiddenIds.has(d.id)) {
      const { error } = await supabase
        .from('diary_hidden')
        .delete()
        .eq('diary_id', d.id)
        .eq('user_id', user.id)
      if (error) toast.error('取消隐藏失败：' + error.message)
    } else {
      const { error } = await supabase
        .from('diary_hidden')
        .insert({ couple_id: coupleId, diary_id: d.id, user_id: user.id })
      if (error) toast.error('隐藏失败：' + error.message)
      setViewing(null)
    }
    reloadHidden()
  }

  // ---- 评论 ----

  const sendComment = async () => {
    if (!draft.trim() || !viewing) return
    setSending(true)
    const { error } = await supabase.from('diary_comments').insert({
      couple_id: coupleId,
      diary_id: viewing.id,
      author_user_id: user.id,
      content: draft.trim(),
    })
    setSending(false)
    if (error) toast.error('评论失败：' + error.message)
    else setDraft('')
  }

  const removeComment = async (id) => {
    const { error } = await supabase.from('diary_comments').delete().eq('id', id)
    if (error) toast.error('删除评论失败：' + error.message)
  }

  // ---- 卡片渲染 ----

  const renderCard = (d, { hidden = false } = {}) => {
    const author = memberMap[d.author_user_id]
    const long = d.content.length > 15
    const imgs = imgsOf(d)
    const cs = commentsOf(d.id)
    const isMine = d.author_user_id === user?.id

    return (
      <Card
        key={d.id}
        className="animate-floatIn relative cursor-pointer transition hover:shadow-card active:scale-[0.99]"
        onClick={() => setViewing(d)}
      >
        <div className="mb-2 flex items-center justify-between pr-16">
          <div className="flex items-center gap-2">
            <Avatar member={author} size="md" />
            <div>
              <div className="text-sm font-bold text-cocoa">{author?.nickname || 'TA'}</div>
              <div className="text-xs text-cocoaSoft/70">{formatDateTime(d.created_at)}</div>
            </div>
          </div>
          <span className="rounded-full bg-cream px-2.5 py-1 text-xs font-bold text-cocoaSoft">
            {moodEmoji(d.mood)} {d.mood}
          </span>
        </div>

        <p className={`whitespace-pre-wrap break-words text-cocoa ${long ? 'break-all' : ''}`}>
          {long ? `${d.content.slice(0, 15)}…` : d.content}
        </p>

        {imgs.length > 0 && (
          <div className="mt-2 flex gap-2">
            {imgs.map((p, i) => (
              <SmartImg
                key={p + i}
                src={imgSrcs[p] || ''}
                alt={`配图 ${i + 1}`}
                className="h-16 w-16 rounded-xl object-cover shadow-soft"
              />
            ))}
          </div>
        )}

        <div className="mt-2 flex items-center gap-3 text-xs font-bold text-cocoaSoft/70">
          {long && <span className="text-rosy">点击查看全文 →</span>}
          {cs.length > 0 && <span>💬 {cs.length} 条评论</span>}
        </div>

        {/* 右上角：隐藏 + 删除（仅自己的日记） */}
        <div className="absolute right-3 top-3 flex items-center gap-2">
          <button
            title={hidden ? '恢复显示' : '隐藏这篇'}
            onClick={(e) => {
              e.stopPropagation()
              toggleHide(d)
            }}
            className={`rounded-full px-2 py-1 text-sm transition ${
              hidden ? 'bg-peach/50 hover:bg-peach' : 'text-cocoaSoft/50 hover:bg-cream hover:text-cocoa'
            }`}
          >
            {hidden ? '👁' : '🙈'}
          </button>
          {isMine && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setPendingDelete(d.id)
              }}
              className="rounded-full px-1 text-xs text-cocoaSoft/50 hover:bg-cream hover:text-rosy"
            >
              删除
            </button>
          )}
        </div>
      </Card>
    )
  }

  return (
    <div>
      <SectionTitle right={<Button onClick={() => setOpen(true)}>✏️ 写日记</Button>}>📔 我们的日记</SectionTitle>

      {/* 日期筛选：先选月份，也可精确到某一天 */}
      {!loading && months.length > 0 && (
        <div className="mb-3 space-y-2">
          <div className="flex gap-2 overflow-x-auto pb-1">
            <button
              onClick={() => {
                setMonth('all')
                setDay('')
              }}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold transition ${
                !filterActive ? 'bg-blush text-white shadow-card' : 'bg-white text-cocoaSoft'
              }`}
            >
              全部 {visible.length}
            </button>
            {months.map((m) => {
              const active = !day && month === m
              return (
                <button
                  key={m}
                  onClick={() => {
                    setMonth(m)
                    setDay('')
                  }}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold transition ${
                    active ? 'bg-blush text-white shadow-card' : 'bg-white text-cocoaSoft'
                  }`}
                >
                  {monthLabel(m)} {countByMonth(m)}
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <input
                type="date"
                value={day}
                onChange={(e) => setDay(e.target.value)}
                className="rounded-xl border-2 border-peach/60 bg-white px-3 py-1.5 text-xs text-cocoa outline-none focus:border-blush"
              />
              {/* iOS 的 date input 空值时是一块白色空白，叠一个占位文字（仅在未选日期时显示） */}
              {!day && (
                <span className="pointer-events-none absolute inset-0 flex items-center px-3 text-xs font-bold text-cocoaSoft/50">
                  📅 选择日期
                </span>
              )}
            </div>
            {day && (
              <button
                onClick={() => setDay('')}
                className="rounded-full bg-white px-3 py-1.5 text-xs font-bold text-rosy shadow-soft"
              >
                ✕ 取消日期
              </button>
            )}
            <span className="ml-auto text-xs font-bold text-cocoaSoft/70">
              {filterActive ? `${filtered.length} 篇` : ''}
            </span>
          </div>
        </div>
      )}

      {loading ? (
        <Spinner />
      ) : filtered.length === 0 ? (
        <EmptyState
          emoji={visible.length === 0 ? '📔' : '🔍'}
          text={visible.length === 0 ? '还没有日记，写下今天想对 TA 说的话吧' : '这段时间没有日记，换个日期看看'}
        />
      ) : (
        <div className="space-y-3">{filtered.map((d) => renderCard(d))}</div>
      )}

      {/* 加载更多 */}
      {!loading && filtered.length > 0 && (
        <LoadMore hasMore={hasMore} loading={loadingMore} onLoadMore={loadMore} />
      )}

      {/* 已隐藏入口 */}
      {hiddenList.length > 0 && (
        <div className="mt-4">
          <button
            onClick={() => setShowHidden((v) => !v)}
            className="flex w-full items-center justify-between rounded-2xl bg-peach/30 px-4 py-2.5 text-sm font-bold text-cocoaSoft"
          >
            <span>🙈 已隐藏 {hiddenList.length} 篇（只有你看不到）</span>
            <span>{showHidden ? '收起 ▲' : '展开 ▼'}</span>
          </button>
          {showHidden && <div className="mt-3 space-y-3">{hiddenList.map((d) => renderCard(d, { hidden: true }))}</div>}
        </div>
      )}

      {/* 最近删除 */}
      <button
        onClick={() => setTrashOpen(true)}
        className="mt-4 flex w-full items-center justify-between rounded-2xl bg-cocoaSoft/10 px-4 py-2.5 text-sm font-bold text-cocoaSoft"
      >
        <span>
          🗑 最近删除{' '}
          {trashItems.length > 0 ? `${trashItems.length} 篇 · 3 天后自动清除` : '（暂无）'}
        </span>
        <span>查看 ›</span>
      </button>

      <TrashModal
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        items={trashItems}
        emptyText="还没有删除的日记"
        onRestore={(item) => restore(item.d)}
        onPurge={setPendingPurge}
        canRestore={(item) => item.d.author_user_id === user?.id}
        renderItem={({ d }) => (
          <div>
            <div className="mb-1 flex items-center justify-between text-xs font-bold text-cocoaSoft/70">
              <span>
                {memberMap[d.author_user_id]?.nickname || 'TA'} · {formatDateTime(d.created_at)}
              </span>
              <span className="text-cocoaSoft/60">{moodEmoji(d.mood)}</span>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm text-cocoa">
              {d.content.length > 60 ? `${d.content.slice(0, 60)}…` : d.content}
            </p>
            {imgsOf(d).length > 0 && (
              <div className="mt-2 flex gap-2">
                {imgsOf(d).map((p, i) => (
                  <SmartImg key={p + i} src={imgSrcs[p] || ''} alt={`配图 ${i + 1}`} className="h-12 w-12 rounded-lg object-cover" />
                ))}
              </div>
            )}
          </div>
        )}
      />

      {/* 写日记 */}
      <Modal open={open} onClose={() => setOpen(false)} title="写日记">
        <div className="space-y-4">
          <div>
            <span className="mb-1.5 block text-sm font-bold text-cocoaSoft">今天的心情</span>
            <div className="flex flex-wrap gap-2">
              {MOODS.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMood(m.value)}
                  className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-bold transition ${
                    mood === m.value ? 'bg-blush text-white shadow-card' : 'bg-cream text-cocoaSoft'
                  }`}
                >
                  <span>{m.emoji}</span>
                  {m.value}
                </button>
              ))}
            </div>
          </div>

          <TextArea
            rows={5}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="今天发生了什么？想对 TA 说点什么？"
          />

          <div>
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={pickImages} />
            <div className="flex flex-wrap items-center gap-2">
              {files.map((f, i) => (
                <div key={f.url + i} className="relative">
                  <img src={f.url} alt={`待上传 ${i + 1}`} className="h-16 w-16 rounded-xl object-cover shadow-soft" />
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-cocoa/70 text-xs text-white"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {files.length < MAX_IMAGES && (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex h-16 w-16 flex-col items-center justify-center rounded-xl border-2 border-dashed border-peach bg-white text-cocoaSoft/70"
                >
                  <span className="text-lg">＋</span>
                  <span className="text-[10px]">配图</span>
                </button>
              )}
            </div>
            <p className="mt-1 text-xs text-cocoaSoft/60">最多 {MAX_IMAGES} 张，可不配图</p>
          </div>

          <Button className="w-full" onClick={submit} disabled={saving || (!content.trim() && files.length === 0)}>
            {saving ? '保存中…' : '保存日记'}
          </Button>
        </div>
      </Modal>

      {/* 全文 + 评论 */}
      <Modal open={!!viewing} onClose={() => { setViewing(null); setDraft('') }} title="日记全文">
        {viewing && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Avatar member={memberMap[viewing.author_user_id]} size="md" />
                <div>
                  <div className="text-sm font-bold text-cocoa">
                    {memberMap[viewing.author_user_id]?.nickname || 'TA'}
                  </div>
                  <div className="text-xs text-cocoaSoft/70">{formatDateTime(viewing.created_at)}</div>
                </div>
              </div>
              <span className="rounded-full bg-cream px-2.5 py-1 text-xs font-bold text-cocoaSoft">
                {moodEmoji(viewing.mood)} {viewing.mood}
              </span>
            </div>

            {imgsOf(viewing).length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {imgsOf(viewing).map((p, i) => (
                  <button key={p + i} onClick={() => setLightbox(p)} className="block">
                    <SmartImg src={imgSrcs[p] || ''} alt={`配图 ${i + 1}`} className="aspect-square w-full rounded-xl object-cover shadow-soft" />
                  </button>
                ))}
              </div>
            )}

            <div className="max-h-[40vh] overflow-y-auto rounded-2xl bg-cream/60 px-4 py-3">
              <p className="whitespace-pre-wrap break-words break-all text-cocoa">{viewing.content}</p>
            </div>

            {/* 评论区 */}
            <div className="space-y-3">
              <p className="text-sm font-bold text-cocoaSoft">💬 评论 ({commentsOf(viewing.id).length})</p>
              {commentsOf(viewing.id).length === 0 ? (
                <p className="text-xs text-cocoaSoft/60">还没有评论，说点什么吧</p>
              ) : (
                <div className="space-y-2">
                  {commentsOf(viewing.id).map((c) => (
                    <div key={c.id} className="flex items-start gap-2 rounded-2xl bg-white px-3 py-2 shadow-soft">
                      <Avatar member={memberMap[c.author_user_id]} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-cocoa">
                            {memberMap[c.author_user_id]?.nickname || 'TA'}
                          </span>
                          <span className="text-[10px] text-cocoaSoft/60">{formatDateTime(c.created_at)}</span>
                        </div>
                        <p className="whitespace-pre-wrap break-words break-all text-sm text-cocoa">{c.content}</p>
                      </div>
                      {c.author_user_id === user?.id && (
                        <button
                          onClick={() => removeComment(c.id)}
                          className="text-xs text-cocoaSoft/40 hover:text-rosy"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-end gap-2">
                <TextArea
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="写一句评论…"
                  className="flex-1"
                />
                <Button onClick={sendComment} disabled={sending || !draft.trim()}>
                  {sending ? '发送中' : '发送'}
                </Button>
              </div>
            </div>

            <div className="flex gap-2 border-t border-peach/40 pt-3">
              <Button variant="ghost" className="flex-1" onClick={() => toggleHide(viewing)}>
                🙈 隐藏这篇
              </Button>
              {viewing.author_user_id === user?.id && (
                <Button variant="ghost" className="flex-1" onClick={() => setPendingDelete(viewing.id)}>
                  删除
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* 大图查看 */}
      <Modal open={!!lightbox} onClose={() => setLightbox(null)} title="配图">
        {lightbox && <SmartImg eager src={lightboxSrc} alt="配图大图" className="w-full rounded-2xl bg-cream/60" />}
      </Modal>

      <ConfirmModal
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => remove(pendingDelete)}
        message="删除后放进「最近删除」，3 天内可以恢复，到期自动清除。确定删除吗？"
      />

      <ConfirmModal
        open={!!pendingPurge}
        onClose={() => setPendingPurge(null)}
        onConfirm={() => purge(pendingPurge)}
        title="彻底删除？"
        message="彻底删除后配图也会一并清掉，无法再恢复。确定吗？"
        confirmLabel="彻底删除"
      />
    </div>
  )
}
