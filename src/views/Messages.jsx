// 留言板：写操作已拆到 messages/useMessageActions.js、卡片渲染到 messages/MessageCard.jsx，
// 本文件只做编排——取数据、算筛选、把状态分给子组件。
import { useState } from 'react'
import { useStore } from '../lib/store.jsx'
import { useCollection, usePagedCollection, formatDateTime, todayStr } from '../lib/hooks.js'
import { Button, EmptyState, Spinner, SectionTitle, ConfirmModal, Modal, TextArea } from '../components/ui.jsx'
import { Avatar } from '../components/Avatar.jsx'
import VoiceRecorderModal from '../components/VoiceRecorderModal.jsx'
import SmartImg from '../components/SmartImg.jsx'
import TrashModal from '../components/TrashModal.jsx'
import { isExpiredAt } from '../lib/trash.js'
import { useSignedMap, useSignedSrc } from '../lib/storage.js'
import LoadMore from '../components/LoadMore.jsx'
import { useMessageActions } from './messages/useMessageActions.js'
import MessageCard, { MessageBody } from './messages/MessageCard.jsx'
import { PREVIEW_TF, monthKey, dayKey, monthLabel, noteStyle } from './messages/constants.js'

export default function Messages() {
  const { coupleId, user, members } = useStore()
  // 主留言流分页：首屏最近 30 条，滚动到底加载更早的（数据量大时首屏不再拉全表）
  const { rows, loading, loadingMore, hasMore, loadMore } = usePagedCollection('messages', coupleId, {
    orderBy: 'created_at',
    ascending: false,
  })
  const { rows: hiddenRows, reload: reloadHidden } = useCollection('message_hidden', coupleId)
  // 评论是双方共享的内容（与「删除/隐藏只对自己生效」不同），按 couple 订阅
  const { rows: comments } = useCollection('message_comments', coupleId, { orderBy: 'created_at', ascending: true })
  const { rows: reactions, reload: reloadReactions } = useCollection('message_reactions', coupleId)

  const [viewingImg, setViewingImg] = useState(null) // 灯箱：正在看大图的留言
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [month, setMonth] = useState('all') // 'all' 或 'YYYY-MM'
  const [day, setDay] = useState(todayStr()) // 'YYYY-MM-DD'，优先于月份；默认今天（iOS 空值会显示白块）

  const memberMap = Object.fromEntries(members.map((m) => [m.user_id, m]))
  const commentsOf = (id) => comments.filter((c) => c.message_id === id)
  const rowsById = Object.fromEntries(rows.map((m) => [m.id, m]))

  // ---------- 私有桶签名 URL（photos/voice，一次批量签，内存缓存） ----------
  const voiceSrcs = useSignedMap('voice', rows.filter((m) => m.voice_path).map((m) => m.voice_path))
  const imgSrcs = useSignedMap('photos', rows.filter((m) => m.image_path).map((m) => m.image_path))
  // 灯箱大图按需单签 + contain 变换
  const lightboxSrc = useSignedSrc('photos', viewingImg?.image_path || null, PREVIEW_TF)

  // 删除/隐藏都是「只对自己生效」，按人各存一份；有记录 = 我这里不可见
  const flagOf = new Map(hiddenRows.filter((h) => h.user_id === user?.id).map((h) => [h.message_id, !!h.permanent]))
  const visibleMsgs = rows.filter((m) => !flagOf.has(m.id))
  const hiddenList = rows.filter((m) => flagOf.get(m.id) === false)

  // 所有写操作：发送 / 回应 / 删除 / 恢复 / 评论 / 隐藏，全在 messages/useMessageActions.js
  const act = useMessageActions({
    coupleId,
    user,
    reactions,
    reloadReactions,
    reloadHidden,
    flagOf,
    rowsById,
    // 发完清掉日期筛选，否则正看着历史月份时新留言会被过滤挡住、以为没发出去
    onSent: () => {
      setMonth('all')
      setDay('')
    },
  })
  const {
    draftText,
    setDraftText,
    sending,
    sendingImg,
    sendText,
    onPickImage,
    sendVoice,
    reactFor,
    setReactFor,
    toggleReaction,
    reactionsOf,
    commenting,
    setCommenting,
    commentDraft,
    setCommentDraft,
    commentSending,
    sendComment,
    removeComment,
    pendingDelete,
    setPendingDelete,
    pendingPurge,
    setPendingPurge,
    remove,
    restore,
    purge,
    toggleHide,
  } = act

  // ---- 混合时间流：只放留言本体（文字/语音/图片/回复），按时间倒序（新的在上）----
  // 评论是附着内容，收进留言详情弹窗（点卡上的 💬），不再混入主流，避免总页太杂
  const feed = visibleMsgs.map((m) => ({ t: m.created_at, kind: 'msg', m })).sort((a, b) => (a.t < b.t ? 1 : -1))

  // 日期筛选：先按月，选了具体某天则以天为准（与日记一致）
  const months = [...new Set(feed.map((f) => monthKey(f.t)))].sort().reverse()
  const countByMonth = (k) => feed.filter((f) => monthKey(f.t) === k).length
  const matchFilter = (f) => (day ? dayKey(f.t) === day : month === 'all' || monthKey(f.t) === month)
  const filtered = feed.filter(matchFilter)
  const filterActive = day !== '' || month !== 'all'

  // 最近删除：直接从「只对自己删除」的隐藏记录推导，不依赖额外的回收站表
  const trashItems = hiddenRows
    .filter(
      (h) =>
        h.user_id === user?.id &&
        h.permanent &&
        !h.purged_at &&
        !isExpiredAt(h.created_at),
    )
    .map((h) => ({ id: h.message_id, deletedAt: h.created_at, m: rows.find((r) => r.id === h.message_id) }))
    .filter((x) => x.m)

  return (
    <div>
      <SectionTitle>💌 留言板</SectionTitle>
      <p className="mb-3 -mt-1 text-xs text-cocoaSoft">文字、语音、照片和表情，都贴在这一面墙上</p>

      {/* 输入栏：文字 + 语音 + 图片 */}
      <div className="mb-3 rounded-2xl bg-white p-2.5 shadow-soft">
        <div className="flex items-center gap-1.5">
          <input
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                sendText()
              }
            }}
            placeholder="给 TA 留句话…"
            className="min-w-0 flex-1 rounded-xl border-2 border-peach/60 bg-white px-3 py-2 text-sm text-cocoa outline-none focus:border-blush"
          />
          <button
            title="录一段语音"
            onClick={() => setVoiceOpen(true)}
            className="shrink-0 rounded-xl bg-blush/10 px-2.5 py-2 text-lg transition hover:bg-blush/20"
          >
            🎙️
          </button>
          <label
            title="发一张图片"
            className={`shrink-0 cursor-pointer rounded-xl bg-blush/10 px-2.5 py-2 text-lg transition hover:bg-blush/20 ${
              sendingImg ? 'pointer-events-none opacity-60' : ''
            }`}
          >
            {sendingImg ? '⏳' : '🖼️'}
            <input type="file" accept="image/*" className="hidden" onChange={onPickImage} disabled={sendingImg} />
          </label>
          <Button onClick={sendText} disabled={sending || !draftText.trim() || sendingImg}>
            {sending ? '…' : '发送'}
          </Button>
        </div>
      </div>

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
              全部 {feed.length}
            </button>
            {months.map((k) => (
              <button
                key={k}
                onClick={() => {
                  setMonth(k)
                  setDay('')
                }}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold transition ${
                  !day && month === k ? 'bg-blush text-white shadow-card' : 'bg-white text-cocoaSoft'
                }`}
              >
                {monthLabel(k)} {countByMonth(k)}
              </button>
            ))}
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
            <span className="ml-auto text-xs font-bold text-cocoaSoft/70">{filterActive ? `${filtered.length} 条` : ''}</span>
          </div>
        </div>
      )}

      {loading ? (
        <Spinner />
      ) : filtered.length === 0 ? (
        <EmptyState
          emoji={feed.length === 0 ? '💌' : '🔍'}
          text={feed.length === 0 ? '还没有留言，写句话、录段语音或发张照片吧' : '这段时间没有留言，换个日期看看'}
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((f) => (
            <MessageCard
              key={f.m.id}
              m={f.m}
              memberMap={memberMap}
              rowsById={rowsById}
              flagOf={flagOf}
              voiceSrcs={voiceSrcs}
              imgSrcs={imgSrcs}
              commentsOf={commentsOf}
              reactionsOf={reactionsOf}
              reactFor={reactFor}
              setReactFor={setReactFor}
              toggleReaction={toggleReaction}
              setViewingImg={setViewingImg}
              setCommenting={setCommenting}
              toggleHide={toggleHide}
              setPendingDelete={setPendingDelete}
            />
          ))}
        </div>
      )}

      {/* 加载更多：数据深度与筛选正交，翻页即扩大可筛选范围 */}
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
            <span>🙈 已隐藏 {hiddenList.length} 条（只有你看不到）</span>
            <span>{showHidden ? '收起 ▲' : '展开 ▼'}</span>
          </button>
          {showHidden && (
            <div className="mt-3 space-y-3">
              {hiddenList.map((m) => (
                <MessageCard
                  key={m.id}
                  m={m}
                  hidden
                  memberMap={memberMap}
                  rowsById={rowsById}
                  flagOf={flagOf}
                  voiceSrcs={voiceSrcs}
                  imgSrcs={imgSrcs}
                  commentsOf={commentsOf}
                  reactionsOf={reactionsOf}
                  reactFor={reactFor}
                  setReactFor={setReactFor}
                  toggleReaction={toggleReaction}
                  setViewingImg={setViewingImg}
                  setCommenting={setCommenting}
                  toggleHide={toggleHide}
                  setPendingDelete={setPendingDelete}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* 最近删除 */}
      <button
        onClick={() => setTrashOpen(true)}
        className="mt-4 flex w-full items-center justify-between rounded-2xl bg-cocoaSoft/10 px-4 py-2.5 text-sm font-bold text-cocoaSoft"
      >
        <span>
          🗑 最近删除{' '}
          {trashItems.length > 0 ? `${trashItems.length} 条 · 3 天后自动清除` : '（暂无）'}
        </span>
        <span>查看 ›</span>
      </button>

      <TrashModal
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        items={trashItems}
        emptyText="还没有删除的留言"
        onRestore={(item) => restore(item.m)}
        onPurge={setPendingPurge}
        renderItem={({ m }) => {
          const { color } = noteStyle(m.id)
          return (
            <div>
              <div className="rounded-xl px-3 py-3" style={{ background: color.bg, border: `1px solid ${color.border}` }}>
                <MessageBody m={m} voiceSrcs={voiceSrcs} imgSrcs={imgSrcs} onOpenImage={setViewingImg} />
              </div>
              <div className="mt-1.5 flex items-center gap-1 text-[10px] font-bold text-cocoaSoft/70">
                <Avatar member={memberMap[m.author_user_id]} size="sm" />
                <span>{memberMap[m.author_user_id]?.nickname || 'TA'}</span>
                <span>· {formatDateTime(m.created_at).slice(5, 16)}</span>
              </div>
            </div>
          )
        }}
      />

      {/* 评论弹窗：评论双方都能看到，下面一排的隐藏/删除仍然只对自己生效 */}
      <Modal
        open={!!commenting}
        onClose={() => {
          setCommenting(null)
          setCommentDraft('')
        }}
        title="💬 留言详情"
      >
        {commenting && (
          <div className="space-y-4">
            <div
              className="rounded-xl px-3 py-3"
              style={{
                background: noteStyle(commenting.id).color.bg,
                border: `1px solid ${noteStyle(commenting.id).color.border}`,
              }}
            >
              <MessageBody m={commenting} voiceSrcs={voiceSrcs} imgSrcs={imgSrcs} onOpenImage={setViewingImg} />
            </div>

            <div className="flex items-center gap-1 text-xs font-bold text-cocoaSoft/70">
              <Avatar member={memberMap[commenting.author_user_id]} size="sm" />
              <span>{memberMap[commenting.author_user_id]?.nickname || 'TA'}</span>
              <span>· {formatDateTime(commenting.created_at)}</span>
            </div>

            <div className="space-y-3">
              <p className="text-sm font-bold text-cocoaSoft">💬 评论 ({commentsOf(commenting.id).length})</p>
              {commentsOf(commenting.id).length === 0 ? (
                <p className="text-xs text-cocoaSoft/60">还没有评论，留一句吧</p>
              ) : (
                <div className="space-y-2">
                  {commentsOf(commenting.id).map((c) => (
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
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                  placeholder="写一句评论…"
                  className="flex-1"
                />
                <Button onClick={sendComment} disabled={commentSending || !commentDraft.trim()}>
                  {commentSending ? '发送中' : '发送'}
                </Button>
              </div>
            </div>

            <div className="flex gap-2 border-t border-peach/40 pt-3">
              <Button variant="ghost" className="flex-1" onClick={() => toggleHide(commenting)}>
                {flagOf.get(commenting.id) === false ? '👁 取消隐藏' : '🙈 隐藏这条'}
              </Button>
              <Button variant="ghost" className="flex-1" onClick={() => setPendingDelete(commenting)}>
                删除
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* 图片灯箱 */}
      <Modal open={!!viewingImg} onClose={() => setViewingImg(null)} title="🖼️ 图片留言">
        {viewingImg && (
          <div>
            <SmartImg eager src={lightboxSrc} alt="图片留言" className="w-full rounded-2xl bg-cream/60" />
            <div className="mt-2 flex items-center gap-1 text-xs font-bold text-cocoaSoft/70">
              <Avatar member={memberMap[viewingImg.author_user_id]} size="sm" />
              <span>{memberMap[viewingImg.author_user_id]?.nickname || 'TA'}</span>
              <span>· {formatDateTime(viewingImg.created_at)}</span>
            </div>
          </div>
        )}
      </Modal>

      <VoiceRecorderModal open={voiceOpen} onClose={() => setVoiceOpen(false)} onSend={sendVoice} />

      <ConfirmModal
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => remove(pendingDelete)}
        message="删除后只对你自己消失（TA 那边照旧能看到），会先放进「最近删除」3 天，期间可恢复。确定删除吗？"
      />

      <ConfirmModal
        open={!!pendingPurge}
        onClose={() => setPendingPurge(null)}
        onConfirm={() => purge(pendingPurge)}
        title="彻底删除？"
        message="彻底删除后这条对你永久消失，无法再恢复（TA 那边不受影响）。确定吗？"
        confirmLabel="彻底删除"
      />
    </div>
  )
}
