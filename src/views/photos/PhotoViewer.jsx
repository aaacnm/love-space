// 大图查看弹窗：看照片、保存原图、加入图集、共同置顶、发起删除。
// 从 Photos.jsx 抽出，全部动作由页面传入。
import { Modal, Button } from '../../components/ui.jsx'
import { Avatar } from '../../components/Avatar.jsx'
import SmartImg from '../../components/SmartImg.jsx'
import { formatDateTime } from '../../lib/hooks.js'
import { viewerSrcSet, VIEWER_SIZES } from '../../lib/mediaUrls.js'

export default function PhotoViewer({
  view,
  onClose,
  viewer,
  memberMap,
  savingOne,
  onSave,
  onMoveToAlbum,
  onTogglePin,
  onDelete,
  saveTip,
}) {
  return (
    <Modal open={!!view} onClose={onClose} title={view?.caption || '照片'}>
      {view && (
        <div className="space-y-3">
          {/* 固定高度容器 + contain：屏幕高度 52% 的框从头到尾都在，图片变化不会推动下面的按钮。
              之前是 w-full 无约束，图下载完会把「保存/图集/置顶/删除」整排按钮顶下去（手一点就点错）。 */}
          <div className="flex h-[52vh] w-full items-center justify-center rounded-2xl bg-cream/60">
            <SmartImg
              eager
              priority
              skeleton
              src={viewer.preview || viewer.full}
              // 1280 预览 + 未变换两档：手机 DPR2 只取 1280，桌面大屏才可能用到大的那档
              srcSet={viewerSrcSet(viewer)}
              sizes={VIEWER_SIZES}
              alt={view.caption || '照片'}
              skeletonClass="h-full w-full rounded-2xl"
              className="max-h-full w-full rounded-2xl object-contain"
            />
          </div>
          <div className="flex items-center justify-center gap-2 text-xs text-cocoaSoft">
            <Avatar member={memberMap[view.author_user_id]} size="sm" />
            <span>
              {memberMap[view.author_user_id]?.nickname} · {formatDateTime(view.created_at)}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            <Button
              className="!px-1 !text-xs"
              onClick={onSave}
              disabled={savingOne}
              title={view.original_path ? '保存原图' : '保存浏览版本'}
            >
              {savingOne ? '保存中…' : '⬇ 保存'}
            </Button>
            <Button variant="ghost" className="!px-1 !text-xs" onClick={onMoveToAlbum}>
              📁 图集
            </Button>
            <Button
              variant="ghost"
              className="!px-1 !text-xs"
              onClick={onTogglePin}
              title="共同置顶：排最前、优先当图集封面"
            >
              {view.pinned_at ? '📌 取消' : '📌 置顶'}
            </Button>
            <Button variant="ghost" className="!px-1 !text-xs" onClick={onDelete}>
              删除
            </Button>
          </div>
          {!view.original_path && (
            <p className="text-center text-[10px] text-cocoaSoft/70">
              这张是早期上传的，没有单独存原图，保存的是浏览版本
            </p>
          )}
          {saveTip && (
            <p className="rounded-2xl bg-matcha/20 px-3 py-2 text-center text-xs font-bold text-cocoa animate-pop">
              {saveTip}
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}
