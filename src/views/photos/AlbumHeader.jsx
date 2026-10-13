// 图集导航胶囊（同时是拖拽落点）+ 当前图集的信息卡（封面 / 时间范围 / 简介 / 操作）。
// 从 Photos.jsx 抽出：只读 props，所有写操作由页面传进来的回调完成。
import SmartImg from '../../components/SmartImg.jsx'
import { fmtMonth } from './constants.js'

export default function AlbumHeader({
  active,
  liveAlbums,
  unfiled,
  inAlbum,
  coverOf,
  rangeOf,
  thumbSrcOf,
  pendingAlbumIds,
  exporting,
  currentAlbum,
  dragPhoto,
  dragOverAlbum,
  setDragOverAlbum,
  setDragPhoto,
  applyAlbum,
  switchView,
  setRenaming,
  exportAlbum,
  setPendingDeleteAlbum,
}) {
  // 图集胶囊（同时是拖拽落点）
  const albumChip = (albumId, name, count, coverPhoto, key) => {
    const isActive =
      key === 'unfiled' ? active.kind === 'unfiled' : active.kind === 'album' && active.id === albumId
    const highlighted = dragOverAlbum === key && !!dragPhoto
    return (
      <div
        key={key}
        onClick={() => switchView(key === 'unfiled' ? { kind: 'unfiled' } : { kind: 'album', id: albumId })}
        onDragOver={(e) => {
          e.preventDefault()
          if (dragPhoto) setDragOverAlbum(key)
        }}
        onDragLeave={() => setDragOverAlbum((cur) => (cur === key ? null : cur))}
        onDrop={(e) => {
          e.preventDefault()
          setDragOverAlbum(null)
          if (dragPhoto) applyAlbum([dragPhoto], albumId, { closeSelect: false })
          setDragPhoto(null)
        }}
        className={`relative shrink-0 cursor-pointer rounded-2xl px-3 py-2 text-center shadow-soft transition ${
          isActive ? 'bg-blush text-white' : 'bg-white text-cocoaSoft'
        } ${highlighted ? 'scale-105 ring-2 ring-rosy' : ''}`}
        style={{ minWidth: 84 }}
      >
        {coverPhoto ? (
          <SmartImg src={thumbSrcOf(coverPhoto)} alt={name} className="mx-auto mb-1 h-10 w-10 rounded-xl object-cover" />
        ) : (
          <div className="mx-auto mb-1 flex h-10 w-10 items-center justify-center rounded-xl bg-peach/50 text-lg">
            {key === 'unfiled' ? '🗂' : '🖼'}
          </div>
        )}
        <p className="max-w-[76px] truncate text-xs font-bold">
          {name}
          {albumId && pendingAlbumIds.has(albumId) && ' ⏳'}
        </p>
        <p className={`text-[10px] ${isActive ? 'text-white/80' : 'text-cocoaSoft/70'}`}>{count} 张</p>
      </div>
    )
  }

  return (
    <>
      {/* 图集导航（可拖拽放入） */}
      <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
        {albumChip(null, '未分组', unfiled.length, unfiled[0], 'unfiled')}
        {liveAlbums.map((a) => albumChip(a.id, a.name, inAlbum(a.id).length, coverOf(a.id), a.id))}
      </div>

      {/* 当前图集的信息卡：封面自动生成 + 时间范围 + 简介 */}
      {currentAlbum && (
        <div className="mb-3 rounded-2xl bg-white p-3 shadow-soft">
          <div className="flex items-center gap-3">
            {coverOf(currentAlbum.id) ? (
              <div className="relative shrink-0">
                <SmartImg
                  src={thumbSrcOf(coverOf(currentAlbum.id))}
                  alt={currentAlbum.name}
                  className="h-14 w-14 rounded-xl object-cover"
                />
                {coverOf(currentAlbum.id)?.pinned_at && (
                  <span className="absolute -left-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-white text-[10px] shadow-soft">
                    📌
                  </span>
                )}
              </div>
            ) : (
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-peach/40 text-xl">
                🖼
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-cocoa">📁 {currentAlbum.name}</p>
              {(() => {
                const range = rangeOf(currentAlbum.id)
                if (!range) return <p className="mt-0.5 text-[11px] text-cocoaSoft/70">还没有照片</p>
                return (
                  <p className="mt-0.5 text-[11px] text-cocoaSoft/80">
                    🗓{' '}
                    {range.min !== range.max
                      ? `${fmtMonth(range.min)} - ${fmtMonth(range.max)}`
                      : fmtMonth(range.min)}{' '}
                    · {range.count} 张
                  </p>
                )
              })()}
              {currentAlbum.description ? (
                <p className="mt-0.5 line-clamp-2 text-xs text-cocoaSoft">{currentAlbum.description}</p>
              ) : (
                <button
                  onClick={() => setRenaming(currentAlbum)}
                  className="mt-0.5 text-[11px] text-cocoaSoft/50 hover:text-rosy"
                >
                  写一句简介，让这个图集更有故事 ›
                </button>
              )}
            </div>
          </div>
          <div className="mt-2.5 flex items-center gap-3 border-t border-peach/30 pt-2">
            <button onClick={() => setRenaming(currentAlbum)} className="text-xs font-bold text-cocoaSoft">
              ✏️ 编辑
            </button>
            <button
              onClick={() => exportAlbum(currentAlbum)}
              disabled={!!exporting}
              className="text-xs font-bold text-cocoaSoft disabled:opacity-50"
            >
              {exporting ? `📦 打包中 ${exporting.done}/${exporting.total}…` : '⬇ 导出'}
            </button>
            <span className="flex-1" />
            <button onClick={() => setPendingDeleteAlbum(currentAlbum.id)} className="text-xs font-bold text-rosy">
              删除图集
            </button>
          </div>
        </div>
      )}
    </>
  )
}
