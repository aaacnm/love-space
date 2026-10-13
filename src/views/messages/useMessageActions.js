// 留言板的所有写操作：发文字/图片/语音、表情回应、删除与恢复、评论、隐藏。
// 从 Messages.jsx 抽出。页面只负责把按钮接到这些动作上。
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { toast } from '../../lib/toast.jsx'
import { compressImage } from '../../lib/image.js'
import { removeUploads } from '../../lib/storage.js'

export function useMessageActions({
  coupleId,
  user,
  reactions,
  reloadReactions,
  reloadHidden,
  flagOf,
  onSent, // 发完清掉日期筛选（否则新留言会被过滤挡住，像没发出去）
}) {
  const [draftText, setDraftText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendingImg, setSendingImg] = useState(false)
  const [reactFor, setReactFor] = useState(null) // 正在选择表情回应的留言 id
  const [pendingDelete, setPendingDelete] = useState(null)
  const [pendingPurge, setPendingPurge] = useState(null)
  const [commenting, setCommenting] = useState(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSending, setCommentSending] = useState(false)

  // ---- 发文字 ----
  const sendText = async () => {
    const text = draftText.trim()
    if (!text || sending) return
    setSending(true)
    const { error } = await supabase.from('messages').insert({
      couple_id: coupleId,
      author_user_id: user.id,
      content: text,
    })
    setSending(false)
    if (error) {
      toast.error('发送失败：' + error.message)
      return
    }
    setDraftText('')
    onSent?.()
  }

  // ---- 发图片 ----
  const onPickImage = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = '' // 允许连选同一张
    if (!file || sendingImg) return
    setSendingImg(true)
    try {
      const { file: small } = await compressImage(file)
      const ext = small.type === 'image/png' ? 'png' : 'jpg'
      const path = `messages/${coupleId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const { error: upErr } = await supabase.storage.from('photos').upload(path, small, {
        cacheControl: '31536000',
        contentType: small.type || 'image/jpeg',
        upsert: false,
      })
      if (upErr) throw upErr
      const { error } = await supabase.from('messages').insert({
        couple_id: coupleId,
        author_user_id: user.id,
        content: '',
        image_path: path,
      })
      if (error) {
        // 库没写进去就把文件删掉，别留孤儿文件；删不掉也要让用户知道（否则网络异常时静默污染）
        const rm = await removeUploads('photos', [path])
        throw new Error(
          error.message + (rm.error ? `（另外，已上传的图片没能删掉，会留下孤儿文件：${rm.error.message}）` : ''),
        )
      }
      onSent?.()
    } catch (err) {
      toast.error('图片发送失败：' + ((err && err.message) || '请重试'))
    } finally {
      setSendingImg(false)
    }
  }

  // ---- 发语音 ----
  // 发送失败抛错（弹窗捕获后留在试听界面），成功 return true —— 只有成功才关弹窗
  const sendVoice = async ({ blob, seconds, ext }) => {
    const path = `${coupleId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error: upErr } = await supabase.storage.from('voice').upload(path, blob, {
      contentType: blob.type || (ext === 'wav' ? 'audio/wav' : 'audio/webm'),
      cacheControl: '31536000',
    })
    if (upErr) throw new Error('语音上传失败：' + upErr.message)
    const { error } = await supabase.from('messages').insert({
      couple_id: coupleId,
      author_user_id: user.id,
      content: '',
      voice_path: path,
      voice_seconds: seconds,
    })
    if (error) {
      // 库没写进去就把文件删掉，别留孤儿文件；删不掉也要让用户知道
      const rm = await removeUploads('voice', [path])
      throw new Error(
        '发送失败：' +
          error.message +
          (rm.error ? `（另外，已上传的语音没能删掉，会留下孤儿文件：${rm.error.message}）` : ''),
      )
    }
    onSent?.()
    return true
  }

  // ---- 表情回应：再点一次同款 = 取消 ----
  const toggleReaction = async (m, emoji) => {
    const mine = reactions.find((r) => r.message_id === m.id && r.user_id === user.id && r.emoji === emoji)
    if (mine) {
      const { error } = await supabase.from('message_reactions').delete().eq('id', mine.id)
      if (error) toast.error('取消回应失败：' + error.message)
    } else {
      const { error } = await supabase.from('message_reactions').insert({
        couple_id: coupleId,
        message_id: m.id,
        user_id: user.id,
        emoji,
      })
      if (error) toast.error('回应失败：' + error.message)
    }
    reloadReactions()
    setReactFor(null)
  }

  // 按 emoji 分组计数；mine = 我也点了这个
  const reactionsOf = (id) => {
    const map = new Map()
    for (const r of reactions) {
      if (r.message_id !== id) continue
      const g = map.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false }
      g.count++
      if (user?.id && r.user_id === user.id) g.mine = true
      map.set(r.emoji, g)
    }
    return [...map.values()]
  }

  // ---- 删除：只对自己生效（TA 那边照旧能看到，文件保留） ----
  const remove = async (m) => {
    const { error } = await supabase
      .from('message_hidden')
      .upsert(
        {
          couple_id: coupleId,
          message_id: m.id,
          user_id: user.id,
          permanent: true,
          // 重置删除时间：恢复后再删，3 天要重新计
          created_at: new Date().toISOString(),
        },
        { onConflict: 'message_id,user_id' },
      )
    if (error) toast.error('删除失败：' + error.message)
    reloadHidden()
    setPendingDelete(null)
  }

  // 从最近删除里捞回来：撤掉"我看不见"的标记，纸条回到墙上
  const restore = async (m) => {
    await supabase.from('message_hidden').delete().eq('message_id', m.id).eq('user_id', user.id)
    reloadHidden()
  }

  // 提前彻底删除：打上 purged_at 标记，之后这条对我永久消失（TA 那边不受影响）
  // 用 update().select() 让受影响行数可感知：RLS 拦下时 Supabase 不报错、只返回空数组，
  // 那是「旧库缺 UPDATE 策略」的信号，必须明确提示，否则用户以为删掉了其实没删
  const purge = async (item) => {
    if (!item) return
    const { error, data } = await supabase
      .from('message_hidden')
      .update({ purged_at: new Date().toISOString() })
      .eq('message_id', item.m.id)
      .eq('user_id', user.id)
      .select('id')
    if (error) {
      toast.error('彻底删除失败：' + error.message)
      setPendingPurge(null)
      return
    }
    if (!data || data.length === 0) {
      toast.warning(
        '彻底删除没有生效：数据库里留言删除记录缺少「更新」权限。\n请在 Supabase SQL Editor 执行 supabase/migrations/025_message_hidden_policy.sql 后重试。',
      )
      setPendingPurge(null)
      return
    }
    reloadHidden()
    setPendingPurge(null)
  }

  // ---- 评论：双方都能看到、都能写 ----
  const sendComment = async () => {
    if (!commentDraft.trim() || !commenting) return
    setCommentSending(true)
    const { error } = await supabase.from('message_comments').insert({
      couple_id: coupleId,
      message_id: commenting.id,
      author_user_id: user.id,
      content: commentDraft.trim(),
    })
    setCommentSending(false)
    if (error) toast.error('评论失败：' + error.message)
    else setCommentDraft('')
  }

  // 只能删自己发的评论（评论是共享内容，删除对双方都生效）
  const removeComment = async (id) => {
    const { error } = await supabase.from('message_comments').delete().eq('id', id)
    if (error) toast.error('删除评论失败：' + error.message)
  }

  // 正在评论的留言被自己删掉/隐藏后，自动关掉弹窗，避免停留在已消失的内容上
  useEffect(() => {
    if (commenting && flagOf.has(commenting.id)) {
      setCommenting(null)
      setCommentDraft('')
    }
  }, [flagOf, commenting])

  // ---- 隐藏：只对自己生效，可恢复 ----
  const toggleHide = async (m) => {
    const flag = flagOf.get(m.id)
    if (flag === false) {
      const { error } = await supabase
        .from('message_hidden')
        .delete()
        .eq('message_id', m.id)
        .eq('user_id', user.id)
      if (error) toast.error('取消隐藏失败：' + error.message)
    } else {
      const { error } = await supabase
        .from('message_hidden')
        .upsert({ couple_id: coupleId, message_id: m.id, user_id: user.id, permanent: false }, { onConflict: 'message_id,user_id' })
      if (error) toast.error('隐藏失败：' + error.message)
    }
    reloadHidden()
  }

  return {
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
  }
}
