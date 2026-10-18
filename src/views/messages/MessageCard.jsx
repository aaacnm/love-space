// 一张留言便利贴：内容（文字/语音/图片）+ 表情回应 + 评论入口 + 隐藏/删除。
// 从 Messages.jsx 抽出，所有交互都由页面传入的回调完成。
import { Avatar } from '../../components/Avatar.jsx'
import SmartImg from '../../components/SmartImg.jsx'
import VoiceNote from '../../components/VoiceNote.jsx'
import { formatDateTime } from '../../lib/hooks.js'
import { REACTION_EMOJIS, noteStyle, digest } from './constants.js'

// 留言正文：文字 + 语音 + 图片（一条留言可同时含多种，实际发送时互斥）。
// 单独导出——评论弹窗顶部也要展示被评论的那条。
export function MessageBody({ m, voiceSrcs, imgSrcs, onOpenImage, imgPriority = false }) {
  return (
    <>
      {m.content ? (
        <p className="whitespace-pre-wrap break-words break-all text-[15px] leading-relaxed text-cocoa">{m.content}</p>
      ) : null}
      {m.voice_path ? (
        <div className={m.content ? 'mt-2' : ''}>
          {voiceSrcs[m.voice_path] ? (
            <VoiceNote src={voiceSrcs[m.voice_path]} seconds={m.voice_seconds} />
          ) : null}
        </div>
      ) : null}
      {m.image_path ? (
        // 签名 URL 没回来前 src 为空：走 SmartImg 的骨架占位，不再渲染 src="" 的 <img>
        // （空 src 会让浏览器把当前页面当图片再请求一次，多一个请求还闪一下）
        // img 与骨架共用 aspect-[4/3]：高度一开始就定死。等到图下载完才撑开 = 布局跳动，
        // 这正是最影响体感的位移。要看完整比例点开灯箱（那里 contain + 固定容器，不裁切）。
        <SmartImg
          src={imgSrcs[m.image_path]}
          alt="图片留言"
          skeleton
          priority={imgPriority}
          skeletonClass={`aspect-[4/3] w-full rounded-xl ${m.content || m.voice_path ? 'mt-2' : ''}`}
          onClick={() => onOpenImage?.(m)}
          className={`aspect-[4/3] w-full cursor-zoom-in rounded-xl bg-cream/60 object-cover ${
            m.content || m.voice_path ? 'mt-2' : ''
          }`}
        />
      ) : null}
    </>
  )
}

export default function MessageCard({
  m,
  hidden = false,
  memberMap,
  rowsById,
  flagOf,
  voiceSrcs,
  imgSrcs,
  imgPriority = false,
  commentsOf,
  reactionsOf,
  reactFor,
  setReactFor,
  toggleReaction,
  setViewingImg,
  setCommenting,
  toggleHide,
  setPendingDelete,
}) {
  const { color } = noteStyle(m.id)
  const author = memberMap[m.author_user_id]
  const groups = reactionsOf(m.id)

  // 引用条：历史回复消息的只读展示（回复功能已并入评论，新消息不会再有 reply_to；
  // 老数据的上下文要保留，被自己隐藏/删除时降级提示）
  const renderReplyQuote = () => {
    const src = m.reply_to ? rowsById[m.reply_to] : null
    return (
      <div className="mb-2 rounded-lg border-l-2 border-blush bg-white/70 px-2.5 py-1.5 text-xs text-cocoaSoft">
        {src && !flagOf.has(src.id) ? (
          <>
            ↩ 回复 <span className="font-bold">{memberMap[src.author_user_id]?.nickname || 'TA'}</span>：{digest(src)}
          </>
        ) : (
          <>↩ 回复的留言已隐藏或删除</>
        )}
      </div>
    )
  }

  return (
    <div
      key={m.id}
      className="note animate-floatIn relative rounded-xl p-3.5 shadow-soft"
      style={{ background: color.bg, border: `1px solid ${color.border}` }}
    >
      {/* 作者行 */}
      <div className="flex items-center gap-1 pr-10">
        <Avatar member={author} size="sm" />
        <span className="truncate text-xs font-bold text-cocoaSoft/90">{author?.nickname || 'TA'}</span>
        <span className="ml-auto shrink-0 text-[10px] text-cocoaSoft/60">{formatDateTime(m.created_at).slice(5, 16)}</span>
      </div>

      {m.reply_to && renderReplyQuote()}
      <div className={m.reply_to ? 'mt-1' : 'mt-1.5'}>
        <MessageBody
          m={m}
          voiceSrcs={voiceSrcs}
          imgSrcs={imgSrcs}
          onOpenImage={setViewingImg}
          imgPriority={imgPriority}
        />
      </div>

      {/* 动作条：表情回应 chips + 😊+ / 评论（隐藏态不显示） */}
      {!hidden && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {groups.map((g) => (
            <button
              key={g.emoji}
              onClick={() => toggleReaction(m, g.emoji)}
              title={g.mine ? '点一下取消' : '我也点一个'}
              className={`rounded-full px-1.5 py-0.5 text-[11px] font-bold transition ${
                g.mine ? 'bg-white text-rosy shadow-soft' : 'bg-white/60 text-cocoaSoft hover:bg-white'
              }`}
            >
              {g.emoji} {g.count}
            </button>
          ))}
          <button
            onClick={() => setReactFor(reactFor === m.id ? null : m.id)}
            className="rounded-full bg-white/60 px-1.5 py-0.5 text-[11px] font-bold text-cocoaSoft transition hover:bg-white"
          >
            😊+
          </button>
          <span className="flex-1" />
          <button
            onClick={() => setCommenting(m)}
            className="rounded-full bg-white/60 px-1.5 py-0.5 text-[11px] font-bold text-cocoaSoft transition hover:bg-white"
          >
            💬 {commentsOf(m.id).length || '评论'}
          </button>
        </div>
      )}

      {/* emoji 选择排 */}
      {reactFor === m.id && (
        <div className="mt-1.5 flex flex-wrap items-center gap-0.5 rounded-xl bg-white/85 p-1.5">
          {REACTION_EMOJIS.map((em) => (
            <button
              key={em}
              onClick={() => toggleReaction(m, em)}
              className="rounded-full px-1.5 py-1 text-lg transition hover:scale-110 hover:bg-cream"
            >
              {em}
            </button>
          ))}
        </div>
      )}

      {/* 右上角：隐藏（可恢复）+ 删除（只对自己消失） */}
      <div className="absolute right-1.5 top-1 flex items-center gap-1">
        <button
          title={hidden ? '恢复显示' : '隐藏这条'}
          onClick={() => toggleHide(m)}
          className={`rounded-full px-1.5 py-0.5 text-sm transition ${
            hidden ? 'bg-peach/50 hover:bg-peach' : 'text-cocoaSoft/50 hover:bg-white/70 hover:text-cocoa'
          }`}
        >
          {hidden ? '👁' : '🙈'}
        </button>
        {!hidden && (
          <button
            title="删除（只对你自己生效）"
            onClick={() => setPendingDelete(m)}
            className="rounded-full px-1 text-xs text-cocoaSoft/50 hover:bg-white/70 hover:text-rosy"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  )
}
