// 最近删除：入口按钮 + 回收站弹窗 + 彻底删除/一键清空的二次确认。
// 从 Photos.jsx 抽出。恢复与彻底删除的动作由页面（usePhotoDeletion）传入。
import SmartImg from '../../components/SmartImg.jsx'
import TrashModal from '../../components/TrashModal.jsx'
import { ConfirmModal } from '../../components/ui.jsx'
import { formatDateTime } from '../../lib/hooks.js'
import { PHOTO_TRASH_DAYS } from '../../lib/trash.js'

export default function PhotoTrash({
  trashOpen,
  setTrashOpen,
  trashItems,
  user,
  memberMap,
  thumbSrcOf,
  onRestore,
  purgeConfirm,
  setPurgeConfirm,
  purgeItem,
  purgeAllConfirm,
  setPurgeAllConfirm,
  purgingAll,
  purgeAll,
}) {
  return (
    <>
      {/* 最近删除入口 */}
      <div className="mt-4">
        <button
          onClick={() => setTrashOpen(true)}
          className="flex w-full items-center justify-between rounded-2xl bg-cocoaSoft/10 px-4 py-2.5 text-sm font-bold text-cocoaSoft"
        >
          <span>
            🗑 最近删除{' '}
            {trashItems.length > 0 ? `${trashItems.length} 项 · ${PHOTO_TRASH_DAYS} 天后自动清除` : '（暂无）'}
          </span>
          <span>查看 ›</span>
        </button>
      </div>

      <TrashModal
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        items={trashItems}
        days={PHOTO_TRASH_DAYS}
        hint={`照片和图集删掉后会在这里躺 ${PHOTO_TRASH_DAYS} 天，期间可以恢复；「彻底删除」由你自己操作，删了就无法找回。`}
        emptyText="最近删除是空的"
        renderItem={(item) =>
          item.kind === 'photo' ? (
            <div className="flex gap-3">
              <SmartImg
                src={thumbSrcOf(item.photo)}
                alt={item.photo.caption || '照片'}
                className="h-16 w-16 shrink-0 rounded-xl object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-cocoa">{item.photo.caption || '照片'}</p>
                <p className="text-xs text-cocoaSoft/70">
                  {memberMap[item.photo.author_user_id]?.nickname || 'TA'} · {formatDateTime(item.photo.created_at)}
                </p>
                <p className="text-xs text-cocoaSoft/70">
                  由 {item.photo.deleted_by === user?.id ? '你' : 'TA'} 删除
                </p>
              </div>
            </div>
          ) : (
            <div>
              <p className="text-sm font-bold text-cocoa">📁 {item.album.name}</p>
              <p className="text-xs text-cocoaSoft/70">图集已删除，里面的照片回到了「未分组」</p>
            </div>
          )
        }
        onRestore={onRestore}
        onPurge={setPurgeConfirm}
        onPurgeAll={setPurgeAllConfirm}
        purgingAll={purgingAll}
      />

      {/* 彻底删除二次确认（个人操作，真删不可恢复） */}
      <ConfirmModal
        open={!!purgeConfirm}
        onClose={() => setPurgeConfirm(null)}
        onConfirm={() => {
          const item = purgeConfirm
          setPurgeConfirm(null)
          purgeItem(item)
        }}
        title="彻底删除？"
        message={
          purgeConfirm?.kind === 'album'
            ? '图集记录会被真正删除，无法恢复。'
            : '照片和原图文件都会被真正删除，无法恢复。'
        }
        confirmLabel="彻底删除"
      />

      {/* 一键清空二次确认（个人操作，真删不可恢复） */}
      <ConfirmModal
        open={purgeAllConfirm}
        onClose={() => setPurgeAllConfirm(null)}
        onConfirm={() => {
          setPurgeAllConfirm(null)
          purgeAll()
        }}
        title="清空最近删除？"
        message={`这 ${trashItems.length} 项（含原图文件）会被真正删除，无法恢复。`}
        confirmLabel="全部彻底删除"
        busy={purgingAll}
      />
    </>
  )
}
