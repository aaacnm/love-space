// 照片墙：逻辑已拆到 ./photos/ 下（见各 hook 文件头注释），本文件只做编排——
// 取数据、把状态分给子组件、把动作接回 hook。
import { useState } from 'react'
import { useStore } from '../lib/store.jsx'

import { useCollection, usePagedCollection } from '../lib/hooks.js'
import { Button, Modal, TextInput, TextArea, SectionTitle, ConfirmModal } from '../components/ui.jsx'
import { fmtSize, saveImage } from '../lib/image.js'
import SmartImg from '../components/SmartImg.jsx'
import { PHOTO_TRASH_DAYS } from '../lib/trash.js'
import { usePhotoUpload } from './photos/usePhotoUpload.js'
import { usePhotoDeletion } from './photos/usePhotoDeletion.js'
import { useAlbums, usePhotoMemory } from './photos/useAlbums.js'
import AlbumHeader from './photos/AlbumHeader.jsx'
import PhotoGrid from './photos/PhotoGrid.jsx'
import PhotoViewer from './photos/PhotoViewer.jsx'
import PhotoTrash from './photos/PhotoTrash.jsx'
import { fmtFullDate, relTime } from './photos/constants.js'
import { useViewerSrcs, viewerSrcSet, VIEWER_SIZES } from '../lib/mediaUrls.js'
import { useThumbSrcs } from './photos/useThumbSrcs.js'
import { useThumbBackfill } from './photos/useThumbBackfill.js'
import { rollbackUploads } from './photos/upload.js'

// rollbackUploads 已迁到 photos/upload.js：这里是转出，既有测试通过 bundle 具名导入它
export { rollbackUploads }


export default function Photos() {
  const { coupleId, user, members } = useStore()
  // 照片墙分页：首屏最近 PAGE_SIZE 条（默认 18），滚动到底加载更早的。
  // 字段也只取渲染要用的那些（清单见 lib/tableColumns.js），不再 select('*')。
  // 回收站（deleted_at 非空）仍从同一 rows 推导（30 天过期清理），不过滤软删行；
  // 图集导出等「需要全量」的重操作在触发时单独按需拉取（见 exportAlbum）。
  const { rows, loading, loadingMore, hasMore, loadMore, reload } = usePagedCollection('photos', coupleId, {
    orderBy: 'created_at',
    ascending: false,
  })
  const { rows: albums, reload: reloadAlbums } = useCollection('albums', coupleId, { orderBy: 'created_at', ascending: true })
  const { rows: reqRows, reload: reloadRequests } = useCollection('delete_requests', coupleId, {
    orderBy: 'created_at',
    ascending: true,
  })

  // 当前视图：{ kind: 'unfiled' | 'album', id }（没有「全部」，默认停在未分组）
  const [active, setActive] = useState({ kind: 'unfiled' })

  const [view, setView] = useState(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState([]) // photo id 列表

  // 上传 + 保存到本机：压缩、并发上传、入库回滚、iOS 逐张保存全在 photos/usePhotoUpload.js
  const {
    fileRef,
    pending,
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
    advanceBatch,
    finishBatch: closeBatch,
    batchSave: runBatchSave,
  } = usePhotoUpload({ coupleId, user, rows, active, reload })

  // 批量保存收尾要连选择态一起清——选择模式由页面持有，hook 不认识它
  const finishBatch = () => {
    closeBatch()
    setSelected([])
    setSelectMode(false)
  }
  const batchSave = () =>
    runBatchSave(selected, () => {
      setSelected([])
      setSelectMode(false)
    })

  const [pendingDeleteAlbum, setPendingDeleteAlbum] = useState(null)
  const [pendingDeletePhoto, setPendingDeletePhoto] = useState(null)

  const [dragPhoto, setDragPhoto] = useState(null) // 正在拖的照片 id
  const [dragOverAlbum, setDragOverAlbum] = useState(null) // 'unfiled' 或 album id

  const [trashOpen, setTrashOpen] = useState(false)

  const memberMap = Object.fromEntries(members.map((m) => [m.user_id, m]))
  // 单人空间：对方还没加入，删除不需要 TA 审核
  const isSolo = members.length <= 1

  // 选择态由页面持有，归类/批量保存收尾时统一清掉
  const clearSelection = () => {
    setSelected([])
    setSelectMode(false)
  }

  // 图集：派生数据（封面/时间范围/时间线）+ 增删改 + 归类，全在 photos/useAlbums.js
  const albumsApi = useAlbums({
    coupleId,
    rows,
    albums,
    reload,
    reloadAlbums,
    active,
    onCreatedAlbum: (id) => setActive({ kind: 'album', id }),
    onSelectDone: clearSelection,
  })
  const {
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
  } = albumsApi

  // 记忆空间：浏览方式 / 置顶 / 随机回忆 / 导出图集
  const {
    browseMode,
    setBrowseMode,
    memory,
    setMemory,
    memoryViewer,
    exporting,
    togglePin,
    rollMemory,
    exportAlbum,
  } = usePhotoMemory({
    coupleId,
    uid: user?.id,
    rows,
    livePhotos,
    memberMap,
    rangeOf,
    // 大图弹窗开着时同步它的置顶按钮
    onPinned: (id, next) => setView((cur) => (cur && cur.id === id ? { ...cur, pinned_at: next } : cur)),
  })

  // 删除链路：发起申请 / 对方同意 / 撤回 / 回收站恢复与彻底删除，全在 photos/usePhotoDeletion.js
  const {
    toReview,
    myPending,
    pendingPhotoIds,
    pendingAlbumIds,
    reviewing,
    setReviewing,
    trashItems,
    requestDelete,
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
  } = usePhotoDeletion({
    coupleId,
    user,
    rows,
    albums,
    reqRows,
    reload,
    reloadAlbums,
    reloadRequests,
    isSolo,
    // 图集被删掉后跳回「未分组」（当前停留的图集没了）
    onAlbumDeleted: () => setActive({ kind: 'unfiled' }),
  })


  // ---------- 私有桶签名 URL ----------
  // 网格/胶囊/信息卡/确认弹窗/回收站预览共用一个取图入口，且**只加载缩略图**：
  // 有 thumb_path 走批量签名；旧照片没有 thumb_path 就走服务端 480 变换，绝不下原图。
  const thumbSrcOf = useThumbSrcs(rows)
  // 旧照片后台补一份真实缩略图写回 thumb_path：补完它们就转成上面的批量签名通道，
  // 列表里不再出现「缺缩略图」的记录。每次进页面最多补一轮，失败静默（不影响浏览）。
  useThumbBackfill({ rows, coupleId, onDone: reload })
  // 查看弹窗的大图：1280 预览 + 未变换两档，交给 srcset 按屏幕挑
  // （iOS 批量保存那张跟着 batch 状态走，在 usePhotoUpload 里签）
  const viewer = useViewerSrcs('photos', view?.storage_path || null)


  const toggleSelect = (id) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  // 单张 / 批量删除：只发请求，等 TA 同意
  const askDeletePhotos = (ids) => {
    requestDelete({ kind: 'photo', ids })
    setPendingDeletePhoto(null)
    setSelected([])
    setSelectMode(false)
    setView(null)
  }

  // 切换当前视图（未分组 / 某个图集）：顺手退出选择模式
  const switchView = (next) => {
    setActive(next)
    setSelectMode(false)
    setSelected([])
  }

  const currentAlbum = active.kind === 'album' ? liveAlbums.find((a) => a.id === active.id) : null



  return (
    <div>
      <SectionTitle
        right={
          // 手机窄屏三个按钮放得下：小一号 + 禁止按钮内文字换行（否则「回忆」会折成两行）
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              className="whitespace-nowrap !px-2.5 !py-1.5 !text-xs"
              onClick={rollMemory}
              title="随机回忆一张照片"
            >
              🎲 回忆
            </Button>
            <Button variant="ghost" className="whitespace-nowrap !px-2.5 !py-1.5 !text-xs" onClick={() => setNewAlbumOpen(true)}>
              ➕ 图集
            </Button>
            <Button
              className="whitespace-nowrap !px-2.5 !py-1.5 !text-xs"
              onClick={() => {
                openUpload()
                fileRef.current?.click()
              }}
            >
              {progress ? '⏳ 上传中' : '📷 上传'}
            </Button>
          </div>
        }
      >
        🖼️ 照片墙
      </SectionTitle>

      <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={pickFiles} />

      {preparing && (
        <p className="mb-3 rounded-2xl bg-cream px-4 py-2 text-center text-xs text-cocoaSoft animate-pop">
          🖼️ 正在压缩图片，稍等一下…
        </p>
      )}

      {/* 我发起的、还在等 TA 点头的请求 */}
      {myPending.map((r) => (
        <div key={r.id} className="mb-2 flex items-center gap-2 rounded-2xl bg-peach/30 px-4 py-2">
          <span className="flex-1 text-xs text-cocoaSoft">
            ⏳ 等待 TA 确认删除
            {r.kind === 'album' ? `图集「${r.label || ''}」` : ` ${(r.ref_ids || []).length} 张照片`}
          </span>
          <button onClick={() => revoke(r.id)} className="text-xs font-bold text-rosy">
            撤回
          </button>
        </div>
      ))}

      {/* TA 发来的、等我点头的请求（常驻：提醒弹窗叉掉后，随时从这里重新打开） */}
      {toReview.map((r) => (
        <div key={r.id} className="mb-2 flex items-center gap-2 rounded-2xl bg-rosy/10 px-4 py-2">
          <span className="flex-1 text-xs text-cocoaSoft">
            🙋 <b className="text-rosy">{memberMap[r.requester_user_id]?.nickname || 'TA'}</b> 申请删除
            {r.kind === 'album' ? `图集「${r.label || ''}」` : ` ${(r.ref_ids || []).length} 张照片`}，等你确认
          </span>
          <button
            onClick={() => setReviewing(r)}
            className="shrink-0 rounded-full bg-rosy px-3 py-1 text-xs font-bold text-white"
          >
            去确认
          </button>
        </div>
      ))}

      <AlbumHeader
        active={active}
        liveAlbums={liveAlbums}
        unfiled={unfiled}
        inAlbum={inAlbum}
        coverOf={coverOf}
        rangeOf={rangeOf}
        thumbSrcOf={thumbSrcOf}
        pendingAlbumIds={pendingAlbumIds}
        exporting={exporting}
        currentAlbum={currentAlbum}
        dragPhoto={dragPhoto}
        dragOverAlbum={dragOverAlbum}
        setDragOverAlbum={setDragOverAlbum}
        setDragPhoto={setDragPhoto}
        applyAlbum={applyAlbum}
        switchView={switchView}
        setRenaming={setRenaming}
        exportAlbum={exportAlbum}
        setPendingDeleteAlbum={setPendingDeleteAlbum}
      />

      <PhotoGrid
        active={active}
        list={list}
        loading={loading}
        browseMode={browseMode}
        setBrowseMode={setBrowseMode}
        selectMode={selectMode}
        setSelectMode={setSelectMode}
        setSelected={setSelected}
        selected={selected}
        dragPhoto={dragPhoto}
        setDragPhoto={setDragPhoto}
        setDragOverAlbum={setDragOverAlbum}
        toggleSelect={toggleSelect}
        setView={setView}
        timelineGroups={timelineGroups}
        pinnedFirst={pinnedFirst}
        thumbSrcOf={thumbSrcOf}
        liveAlbums={liveAlbums}
        pendingPhotoIds={pendingPhotoIds}
        hasMore={hasMore}
        loadingMore={loadingMore}
        loadMore={loadMore}
      />

      {/* 多选操作条 */}
      {selectMode && (
        <div className="fixed bottom-20 left-0 right-0 z-40 flex justify-center px-4">
          <div className="flex w-full max-w-md items-center gap-2 rounded-full bg-cocoa px-4 py-2.5 text-white shadow-card">
            <span className="text-xs font-bold">已选 {selected.length}</span>
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => setMoveOpen(true)}
                disabled={selected.length === 0}
                className="rounded-full bg-white/20 px-3 py-1 text-xs font-bold disabled:opacity-40"
              >
                加入图集
              </button>
              {currentAlbum && (
                <button
                  onClick={() => applyAlbum(selected, null)}
                  disabled={selected.length === 0}
                  className="rounded-full bg-white/20 px-3 py-1 text-xs font-bold disabled:opacity-40"
                >
                  移出
                </button>
              )}
              <button
                onClick={batchSave}
                disabled={selected.length === 0}
                className="rounded-full bg-white/20 px-3 py-1 text-xs font-bold disabled:opacity-40"
              >
                ⬇ 保存
              </button>
              <button
                onClick={() => setPendingDeletePhoto(selected)}
                disabled={selected.length === 0}
                className="rounded-full bg-rosy px-3 py-1 text-xs font-bold disabled:opacity-40"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 安卓/电脑：静默下载进度 */}
      {savingBatch && (
        <div className="fixed bottom-32 left-0 right-0 z-40 flex justify-center px-4">
          <div className="rounded-full bg-cocoa/90 px-4 py-2 text-xs font-bold text-white shadow-card">
            正在保存 {savingBatch.done}/{savingBatch.total}…
          </div>
        </div>
      )}

      {/* iOS：批量保存逐张确认（系统要求每次存储都要用户手势，无法静默连发） */}
      <Modal
        open={!!batch}
        onClose={() => {
          if (!batchBusy) setBatch(null)
        }}
        title={batch && batch.index < batch.items.length ? `保存照片 ${batch.index + 1}/${batch.items.length}` : '批量保存'}
      >
        {batch &&
          (() => {
            const cur = batch.items[batch.index]
            if (!cur) {
              return (
                <div className="space-y-3 py-2 text-center">
                  <p className="text-5xl">🎉</p>
                  <p className="text-sm font-bold text-cocoa">
                    完成！已保存 {batch.saved} 张{batch.failed ? `，跳过 ${batch.failed} 张` : ''}
                  </p>
                  <Button className="w-full" onClick={finishBatch}>
                    好的
                  </Button>
                </div>
              )
            }
            return (
              <div className="space-y-3">
                <SmartImg
                  eager
                  src={batchSrc}
                  alt={cur.photo.caption || '照片'}
                  className="max-h-72 w-full rounded-2xl bg-cream/60 object-contain"
                />
                <p className="text-center text-xs leading-5 text-cocoaSoft">
                  点「存储到照片」，在系统面板确认后会自动到下一张
                  <br />
                  （iPhone 每张都需要确认一次，这是系统限制）
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="soft"
                    className="flex-1"
                    disabled={batchBusy}
                    onClick={() => advanceBatch(false)}
                  >
                    跳过
                  </Button>
                  <Button
                    className="flex-1"
                    disabled={batchBusy}
                    onClick={async () => {
                      setBatchBusy(true)
                      await saveImage(cur.url, cur.name)
                      advanceBatch(true)
                    }}
                  >
                    {batchBusy ? '保存中…' : '存储到照片'}
                  </Button>
                </div>
              </div>
            )
          })()}
      </Modal>

      {/* 上传确认 */}
      <Modal open={pending.length > 0} onClose={clearPending} title={`上传 ${pending.length} 张照片`}>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {pending.map((f, i) => (
              <div key={f.url + i} className="relative">
                <img src={f.url} alt={`待上传 ${i + 1}`} className="aspect-square w-full rounded-xl object-cover" />
                <button
                  onClick={() => dropPending(i)}
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-cocoa/70 text-xs text-white"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {!saving && compressed && (
            <div className="flex items-center justify-between rounded-2xl bg-cream px-3 py-2 text-xs">
              <span className="text-cocoaSoft">
                已压缩 <b className="text-cocoa">{fmtSize(totalBefore)}</b> →{' '}
                <b className="text-matcha">{fmtSize(totalAfter)}</b>
                <span className="ml-1 text-matcha">
                  （省 {Math.round((1 - totalAfter / totalBefore) * 100)}%）
                </span>
              </span>
            </div>
          )}

          {!saving && (
            <div className="space-y-2 rounded-2xl bg-cream px-3 py-2">
              <label className="flex items-center gap-2 text-xs text-cocoaSoft">
                <input
                  type="checkbox"
                  checked={hdMode || keepOriginal}
                  disabled={hdMode}
                  onChange={(e) => setKeepOriginal(e.target.checked)}
                  className="accent-blush"
                />
                保留原图（你和 TA 都能下载保存，画质无损）
              </label>
              <label className="flex items-center gap-2 text-xs text-cocoaSoft">
                <input
                  type="checkbox"
                  checked={hdMode}
                  onChange={(e) => setHdMode(e.target.checked)}
                  className="accent-blush"
                />
                浏览也用原图（上传和翻看都会明显变慢）
              </label>
            </div>
          )}

          <TextInput
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="给这批照片写一句备注（可选）"
            maxLength={60}
          />

          <div>
            <span className="mb-1.5 block text-sm font-bold text-cocoaSoft">上传到</span>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setUploadTo('')}
                className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                  uploadTo === '' ? 'bg-blush text-white' : 'bg-white text-cocoaSoft'
                }`}
              >
                不分组
              </button>
              {liveAlbums.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setUploadTo(a.id)}
                  className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                    uploadTo === a.id ? 'bg-blush text-white' : 'bg-white text-cocoaSoft'
                  }`}
                >
                  📁 {a.name}
                </button>
              ))}
            </div>
          </div>

          {saving && progress ? (
            <div className="space-y-2">
              <div className="h-2 w-full overflow-hidden rounded-full bg-peach/40">
                <div
                  className="h-full rounded-full bg-blush transition-all duration-300"
                  style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                />
              </div>
              <p className="text-center text-xs text-cocoaSoft">
                上传中 {progress.done}/{progress.total}
                {progress.done === progress.total ? ' · 正在保存…' : ''}
              </p>
            </div>
          ) : (
            <Button className="w-full" onClick={doUpload} disabled={preparing}>
              {preparing ? '正在处理图片…' : `确认上传 ${pending.length} 张`}
            </Button>
          )}
        </div>
      </Modal>

      <PhotoViewer
        view={view}
        onClose={() => setView(null)}
        viewer={viewer}
        memberMap={memberMap}
        savingOne={savingOne}
        onSave={() => saveCurrent(view)}
        onMoveToAlbum={() => {
          setMoveOpen(true)
          setSelected([view.id])
          setView(null)
        }}
        onTogglePin={() => togglePin(view)}
        onDelete={() => setPendingDeletePhoto([view.id])}
        saveTip={saveTip}
      />
      {/* 移动到图集 */}
      <Modal open={moveOpen} onClose={() => setMoveOpen(false)} title="加入图集">
        <div className="space-y-2">
          <button
            onClick={() => applyAlbum(selected, null)}
            className="w-full rounded-2xl bg-white px-4 py-3 text-left text-sm font-bold text-cocoaSoft shadow-soft"
          >
            🗂 移到「未分组」
          </button>
          {liveAlbums.map((a) => (
            <button
              key={a.id}
              onClick={() => applyAlbum(selected, a.id)}
              className="w-full rounded-2xl bg-white px-4 py-3 text-left text-sm font-bold text-cocoa shadow-soft"
            >
              📁 {a.name}
            </button>
          ))}
          {liveAlbums.length === 0 && (
            <p className="text-center text-xs text-cocoaSoft/70">还没有图集，先去新建一个吧</p>
          )}
        </div>
      </Modal>

      {/* 新建图集 */}
      <Modal open={newAlbumOpen} onClose={() => setNewAlbumOpen(false)} title="新建图集">
        <div className="space-y-4">
          <TextInput
            value={albumName}
            onChange={(e) => setAlbumName(e.target.value)}
            placeholder="给图集起个名字，比如「2026 夏天」"
            maxLength={20}
          />
          <Button className="w-full" onClick={createAlbum} disabled={!albumName.trim()}>
            创建
          </Button>
        </div>
      </Modal>

      {/* 随机回忆：从整个相册抽一张老照片看看 */}
      <Modal open={!!memory} onClose={() => setMemory(null)} title="🎲 随机回忆">
        {memory && (
          <div className="space-y-3">
            {/* 固定高度 + contain：下面是日期卡片，「再来一张」按钮位置不随图片跳动 */}
            <div className="flex h-80 w-full items-center justify-center rounded-2xl bg-cream/60">
              <SmartImg
                eager
                priority
                skeleton
                src={memoryViewer.preview || memoryViewer.full}
                srcSet={viewerSrcSet(memoryViewer)}
                sizes={VIEWER_SIZES}
                alt={memory.caption || '回忆'}
                skeletonClass="h-full w-full rounded-2xl"
                className="max-h-full w-full rounded-2xl object-contain"
              />
            </div>
            <div className="rounded-2xl bg-cream/70 px-4 py-3 text-center">
              <p className="text-sm font-bold text-cocoa">
                {fmtFullDate(memory.created_at)} · {relTime(memory.created_at)}
              </p>
              <p className="mt-1 text-xs text-cocoaSoft">
                {memory.album_id &&
                  `📁 ${liveAlbums.find((a) => a.id === memory.album_id)?.name || '图集'} · `}
                {memberMap[memory.author_user_id]?.nickname || 'TA'} 上传
              </p>
              {memory.caption && <p className="mt-1.5 text-xs text-cocoa">{memory.caption}</p>}
            </div>
            <Button variant="soft" className="w-full" onClick={rollMemory}>
              🎲 再来一张
            </Button>
          </div>
        )}
      </Modal>

      {/* 编辑图集：名字 + 简介 */}
      <Modal open={!!renaming} onClose={() => setRenaming(null)} title="编辑图集">
        {renaming && (
          <div className="space-y-4">
            <div>
              <span className="mb-1.5 block text-sm font-bold text-cocoaSoft">名字</span>
              <TextInput
                value={renaming.name}
                onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                maxLength={20}
              />
            </div>
            <div>
              <span className="mb-1.5 block text-sm font-bold text-cocoaSoft">简介（显示在图集卡片上）</span>
              <TextArea
                value={renaming.description || ''}
                onChange={(e) => setRenaming({ ...renaming, description: e.target.value })}
                placeholder="比如：那年夏天的海边，和第一次一起看的日出"
                maxLength={80}
                rows={3}
              />
            </div>
            <Button className="w-full" onClick={saveAlbumInfo} disabled={!renaming.name.trim()}>
              保存
            </Button>
          </div>
        )}
      </Modal>

      <PhotoTrash
        trashOpen={trashOpen}
        setTrashOpen={setTrashOpen}
        trashItems={trashItems}
        user={user}
        memberMap={memberMap}
        thumbSrcOf={thumbSrcOf}
        onRestore={restoreItem}
        purgeConfirm={purgeConfirm}
        setPurgeConfirm={setPurgeConfirm}
        purgeItem={purgeItem}
        purgeAllConfirm={purgeAllConfirm}
        setPurgeAllConfirm={setPurgeAllConfirm}
        purgingAll={purgingAll}
        purgeAll={purgeAll}
      />
      {/* TA 发起的删除请求：需要我点头 */}
      <Modal open={!!reviewing} onClose={() => setReviewing(null)} title="需要你确认">
        {reviewing &&
          (() => {
            const who = memberMap[reviewing.requester_user_id]?.nickname || 'TA'
            const targets = reviewing.kind === 'photo' ? rows.filter((p) => (reviewing.ref_ids || []).includes(p.id)) : []
            return (
              <div className="space-y-3">
                <p className="text-sm text-cocoa">
                  <b className="text-rosy">{who}</b> 申请删除
                  {reviewing.kind === 'album' ? (
                    <>
                      {' '}
                      图集「<b>{reviewing.label}</b>」
                    </>
                  ) : (
                    <>
                      {' '}
                      <b>{targets.length}</b> 张照片
                    </>
                  )}
                </p>

                {reviewing.kind === 'photo' && (
                  <div className="grid grid-cols-3 gap-2">
                    {targets.map((p) => (
                      <SmartImg
                        key={p.id}
                        src={thumbSrcOf(p)}
                        alt={p.caption || '照片'}
                        className="aspect-square w-full rounded-xl object-cover"
                      />
                    ))}
                  </div>
                )}

                <p className="rounded-2xl bg-cream px-3 py-2 text-xs text-cocoaSoft">
                  {reviewing.kind === 'album'
                    ? '同意后图集删除，里面的照片会回到「未分组」；图集本身会先躺进最近删除 30 天，可以恢复。'
                    : `同意后照片会先躺进「最近删除」${PHOTO_TRASH_DAYS} 天，期间还能恢复。`}
                </p>

                <div className="flex gap-2">
                  <Button variant="soft" className="flex-1" onClick={() => respond(false)}>
                    不同意
                  </Button>
                  <Button className="flex-1" onClick={() => respond(true)}>
                    同意删除
                  </Button>
                </div>
              </div>
            )
          })()}
      </Modal>

      <ConfirmModal
        open={!!pendingDeleteAlbum}
        onClose={() => setPendingDeleteAlbum(null)}
        onConfirm={() => {
          const a = liveAlbums.find((x) => x.id === pendingDeleteAlbum)
          requestDelete({ kind: 'album', ids: [pendingDeleteAlbum], label: a?.name })
          setPendingDeleteAlbum(null)
        }}
        title={isSolo ? '删除图集？' : '申请删除图集？'}
        message={
          isSolo
            ? '空间里暂时只有你一个人，无需 TA 审核：图集直接删除（里面的照片回到「未分组」），30 天内可在「最近删除」恢复。'
            : '不会立刻删除——会先发给 TA，TA 同意后图集才删除（里面的照片会回到「未分组」）。'
        }
        confirmLabel={isSolo ? '删除' : '发给 TA'}
      />

      <ConfirmModal
        open={!!pendingDeletePhoto}
        onClose={() => setPendingDeletePhoto(null)}
        onConfirm={() => askDeletePhotos(pendingDeletePhoto)}
        message={
          isSolo
            ? '空间里暂时只有你一个人，无需 TA 审核：照片直接进入「最近删除」，保留 30 天。'
            : Array.isArray(pendingDeletePhoto) && pendingDeletePhoto.length > 1
              ? `这 ${pendingDeletePhoto.length} 张照片不会立刻删除，会先发给 TA 确认；TA 同意后进入「最近删除」保留 30 天。`
              : '不会立刻删除，会先发给 TA 确认；TA 同意后进入「最近删除」保留 30 天。'
        }
        confirmLabel={isSolo ? '删除' : '发给 TA'}
      />
    </div>
  )
}
