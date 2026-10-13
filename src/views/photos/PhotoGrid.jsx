// 照片墙主体：选择条 + 浏览方式切换 + 网格/时间线两种排布 + 加载更多。
// tile（照片瓦片）跟着走，因为它只依赖选择/拖拽这些本组件的局部状态。
import SmartImg from '../../components/SmartImg.jsx'
import { Spinner, EmptyState } from '../../components/ui.jsx'
import LoadMore from '../../components/LoadMore.jsx'

export default function PhotoGrid({
  active,
  list,
  loading,
  browseMode,
  setBrowseMode,
  selectMode,
  setSelectMode,
  setSelected,
  selected,
  dragPhoto,
  setDragPhoto,
  setDragOverAlbum,
  toggleSelect,
  setView,
  timelineGroups,
  pinnedFirst,
  thumbSrcOf,
  liveAlbums,
  pendingPhotoIds,
  hasMore,
  loadingMore,
  loadMore,
}) {
  // 照片瓦片：网格（2 列）和时间线（3 列）共用
  const tile = (p) => {
    const picked = selected.includes(p.id)
    return (
      <div key={p.id} className="group relative animate-floatIn">
        <div
          draggable={!selectMode}
          onDragStart={() => setDragPhoto(p.id)}
          onDragEnd={() => {
            setDragPhoto(null)
            setDragOverAlbum(null)
          }}
          onClick={() => (selectMode ? toggleSelect(p.id) : setView(p))}
          className={`block w-full cursor-pointer overflow-hidden rounded-2xl shadow-soft transition ${
            picked ? 'ring-4 ring-rosy' : ''
          }`}
        >
          <SmartImg
            src={thumbSrcOf(p)}
            alt={p.caption || '照片'}
            className={`aspect-square w-full object-cover transition ${selectMode ? '' : 'group-hover:scale-105'} ${
              dragPhoto === p.id ? 'opacity-50' : ''
            }`}
          />
          {p.pinned_at && !selectMode && (
            <span className="absolute left-2 top-2 rounded-full bg-white/90 px-1.5 py-0.5 text-[10px] shadow-soft">
              📌
            </span>
          )}
          {selectMode && (
            <div className="absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-sm shadow-soft">
              {picked ? '✅' : '⬜'}
            </div>
          )}
          {p.album_id && !selectMode && active.kind !== 'album' && (
            <span className="absolute bottom-2 left-2 rounded-full bg-black/40 px-2 py-0.5 text-[10px] text-white">
              📁 {liveAlbums.find((a) => a.id === p.album_id)?.name || '图集'}
            </span>
          )}
          {pendingPhotoIds.has(p.id) && (
            <span className="absolute right-2 top-2 rounded-full bg-cocoa/80 px-2 py-0.5 text-[10px] font-bold text-white">
              ⏳ 待确认
            </span>
          )}
        </div>
        {p.caption && <p className="mt-1 truncate px-1 text-xs text-cocoaSoft">{p.caption}</p>}
      </div>
    )
  }

  return (
    <>
      {/* 选择模式开关 + 浏览方式（网格 / 时间线） */}
      {list.length > 0 && (
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs text-cocoaSoft/70">
            {list.length} 张照片{dragPhoto || selectMode ? '' : ' · 电脑上可把照片拖到上方图集'}
          </p>
          <div className="flex items-center gap-1">
            <div className="mr-1 flex rounded-full bg-white p-0.5 shadow-soft">
              <button
                onClick={() => setBrowseMode('grid')}
                title="网格浏览"
                className={`rounded-full px-2.5 py-0.5 text-xs transition ${
                  browseMode === 'grid' ? 'bg-blush text-white' : 'text-cocoaSoft'
                }`}
              >
                ▦
              </button>
              <button
                onClick={() => setBrowseMode('timeline')}
                title="按时间线浏览"
                className={`rounded-full px-2.5 py-0.5 text-xs transition ${
                  browseMode === 'timeline' ? 'bg-blush text-white' : 'text-cocoaSoft'
                }`}
              >
                🕑
              </button>
            </div>
            <button
              onClick={() => {
                setSelectMode((v) => !v)
                setSelected([])
              }}
              className="rounded-full px-3 py-1 text-xs font-bold text-rosy"
            >
              {selectMode ? '取消选择' : '选择'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <Spinner />
      ) : list.length === 0 ? (
        <EmptyState
          emoji={active.kind === 'unfiled' ? '🗂' : '🖼️'}
          text={
            active.kind === 'album'
              ? '这个图集还是空的，把照片拖进来或点「加入」'
              : active.kind === 'unfiled'
                ? '没有未分组的照片'
                : '还没有照片，上传你们的合影或日常吧'
          }
        />
      ) : browseMode === 'timeline' ? (
        /* 时间线：按年月分组，左侧一条时间轴 */
        <div className="space-y-5">
          {timelineGroups.map((g, gi) => (
            <div key={g.key} className="relative pl-6">
              {gi < timelineGroups.length - 1 && (
                <span className="absolute bottom-0 left-[7px] top-6 w-px bg-blush/40" aria-hidden />
              )}
              <span
                className="absolute left-0 top-1.5 h-3.5 w-3.5 rounded-full border-2 border-blush bg-white"
                aria-hidden
              />
              <p className="mb-2 text-xs font-bold text-cocoa">
                {g.y}年{g.m}月 <span className="font-normal text-cocoaSoft/60">· {g.items.length} 张</span>
              </p>
              <div className="grid grid-cols-3 gap-2">{g.items.map((p) => tile(p))}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">{pinnedFirst(list).map((p) => tile(p))}</div>
      )}

      {/* 加载更多（空列表不渲染） */}
      {!loading && list.length > 0 && <LoadMore hasMore={hasMore} loading={loadingMore} onLoadMore={loadMore} />}
    </>
  )
}
