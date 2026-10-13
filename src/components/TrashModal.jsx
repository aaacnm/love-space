import { Modal, Button } from './ui.jsx'
import { leftLabel } from '../lib/trash.js'

// item 结构：{ id, deletedAt, ...业务数据 }，内容长什么样由 renderItem 决定

// 最近删除弹窗：日记和留言共用外壳，条目长什么样由 renderItem 决定
// 可选 onPurgeAll：传入则在条目列表上方显示「清空全部」按钮（清空前由父级二次确认）
export default function TrashModal({
  open,
  onClose,
  items,
  days = 3,
  hint = '删掉的内容会在这里躺 3 天，期间可以随时恢复，到期自动清除。',
  emptyText = '最近删除是空的',
  renderItem,
  onRestore,
  onPurge,
  onPurgeAll,
  purgingAll = false,
  canRestore = () => true,
}) {
  return (
    <Modal open={open} onClose={onClose} title="🗑 最近删除">
      <div className="mb-3 -mt-1 flex items-start justify-between gap-2">
        <p className="text-xs text-cocoaSoft/80">{hint}</p>
        {onPurgeAll && items.length > 0 && (
          <Button
            variant="ghost"
            className="!shrink-0 !px-2.5 !py-1 !text-xs"
            disabled={purgingAll}
            onClick={onPurgeAll}
          >
            {purgingAll ? '清空中…' : '🧹 清空全部'}
          </Button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
          <div className="text-4xl">🧺</div>
          <p className="text-sm font-semibold text-cocoaSoft">{emptyText}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.id} className="rounded-2xl bg-white px-4 py-3 shadow-soft">
              {renderItem(item)}

              <div className="mt-2 flex items-center justify-between border-t border-peach/40 pt-2">
                <span className="text-xs font-bold text-rosy">{leftLabel(item.deletedAt, days)}</span>
                <div className="flex gap-2">
                  {canRestore(item) && (
                    <Button variant="soft" className="!px-3 !py-1.5 !text-xs" onClick={() => onRestore(item)}>
                      ↩ 恢复
                    </Button>
                  )}
                  <Button variant="ghost" className="!px-3 !py-1.5 !text-xs" onClick={() => onPurge(item)}>
                    彻底删除
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
