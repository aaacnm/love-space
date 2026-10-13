import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store.jsx'
import { updateMyProfile } from '../lib/couple.js'
import { supabase } from '../lib/supabase.js'
import { AVATAR_EMOJIS } from '../lib/hooks.js'
import { applyGenderTheme } from '../lib/theme.js'
import { removeUploads } from '../lib/storage.js'
import { Modal, Button, Field, TextInput } from './ui.jsx'
import { Avatar } from './Avatar.jsx'
import AvatarCropper from './AvatarCropper.jsx'

export default function EditProfileModal({ open, onClose }) {
  const { myMember, refresh } = useStore()
  const fileRef = useRef(null)
  const previewUrlRef = useRef(null) // 当前预览图的 objectURL，换图/关闭时释放
  const [nickname, setNickname] = useState('')
  const [city, setCity] = useState('')
  const [emoji, setEmoji] = useState('💕')
  const [gender, setGender] = useState(null) // 'male' | 'female' | null
  const [avatarFile, setAvatarFile] = useState(null) // { file, url } 裁剪完成的头像
  const [mode, setMode] = useState('keep') // 'keep' | 'emoji' | 'image'
  const [pendingPick, setPendingPick] = useState(null) // { file } 待裁剪的原图
  const [cropperOpen, setCropperOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // 用裁剪结果替换预览（顺便释放上一张的 objectURL）
  const setPreview = (file) => {
    if (previewUrlRef.current) window.URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = file ? window.URL.createObjectURL(file) : null
    setAvatarFile(file ? { file, url: previewUrlRef.current } : null)
  }

  // 打开时用当前资料回填
  useEffect(() => {
    if (!open) return
    setNickname(myMember?.nickname || '')
    setCity(myMember?.city || '')
    setEmoji(myMember?.emoji || '💕')
    setGender(myMember?.gender || null)
    setPreview(null)
    setMode('keep')
    setPendingPick(null)
    setCropperOpen(false)
    setError('')
  }, [open, myMember])

  // 裁剪弹窗是嵌套 Modal：它关闭时会把 body overflow 清空，
  // 这里在外层仍打开时补回锁定，避免底层抽屉背景可以滚动
  useEffect(() => {
    if (open && !cropperOpen) document.body.style.overflow = 'hidden'
  }, [open, cropperOpen])

  // 性别即时预览：点选瞬间整站换主题色；关闭弹窗（未保存）还原为资料里的主题
  useEffect(() => {
    if (!open) return
    applyGenderTheme(gender)
    return () => applyGenderTheme(myMember?.gender)
  }, [gender, open, myMember])

  const pickFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    // 不直接压缩：先交给裁剪器，用户裁好再导出 512px 方图
    setPendingPick({ file })
    setCropperOpen(true)
  }

  // 裁剪完成：拿到的就是导出好的 512×512 JPEG
  const handleCropped = (file) => {
    setPreview(file)
    setMode('image')
    setCropperOpen(false)
    setPendingPick(null)
  }

  const handleCropCancel = () => {
    setCropperOpen(false)
    setPendingPick(null)
  }

  const pickEmoji = (e) => {
    setEmoji(e)
    setPreview(null)
    setMode('emoji')
  }

  const save = async () => {
    if (!nickname.trim()) {
      setError('先告诉我你的昵称吧～')
      return
    }
    setSaving(true)
    setError('')
    let uploadedAvatar = null // 本次新传上去的路径（资料没写进去时要撤回）
    let staleAvatar = null // 被替换掉的旧头像（资料落库后再删）
    try {
      let avatar_path // undefined=不改；null=清除；string=新路径
      if (mode === 'image' && avatarFile) {
        const ext = avatarFile.file.type === 'image/png' ? 'png' : 'jpg'
        const path = `${crypto.randomUUID()}.${ext}`
        const { error: upErr } = await supabase.storage.from('avatars').upload(path, avatarFile.file, {
          cacheControl: '31536000',
          contentType: avatarFile.file.type || 'image/jpeg',
          upsert: false,
        })
        if (upErr) throw upErr
        avatar_path = path
        uploadedAvatar = path
        staleAvatar = myMember?.avatar_path || null
      } else if (mode === 'emoji') {
        avatar_path = null
      }

      await updateMyProfile({
        nickname: nickname.trim(),
        emoji,
        city: city.trim(),
        timezone: myMember?.timezone || null,
        avatar_path,
        gender,
      })
      await refresh()
      // 旧头像文件等资料落库后再删：否则更新失败时会出现「记录还指向已删文件」的裂图
      if (staleAvatar) await removeUploads('avatars', [staleAvatar])
      onClose()
    } catch (err) {
      // 资料没写进去就把刚传的头像撤回，别在桶里留孤儿文件
      let msg = err?.message || '保存失败，再试一次吧'
      if (uploadedAvatar) {
        const rm = await removeUploads('avatars', [uploadedAvatar])
        if (rm.error) msg += `（另外，刚上传的头像没能删掉，会在存储里留下孤儿文件：${rm.error.message}）`
      }
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  const previewMember = { emoji, avatar_path: mode === 'emoji' ? null : myMember?.avatar_path }

  return (
    <>
      <Modal open={open} onClose={onClose} title="编辑我的资料">
      <div className="space-y-4">
        {/* 头像预览 */}
        <div className="flex items-center gap-4">
          {avatarFile ? (
            <img src={avatarFile.url} alt="预览" className="h-14 w-14 shrink-0 rounded-full object-cover" />
          ) : (
            <Avatar member={previewMember} size="lg" />
          )}
          <div className="space-y-2">
            <Button variant="ghost" onClick={() => fileRef.current?.click()}>
              📷 上传头像
            </Button>
            <p className="text-xs text-cocoaSoft/70">选照片后可裁剪、缩放、旋转</p>
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickFile} />
        </div>

        {/* emoji 选择（选表情 = 恢复表情头像） */}
        <div>
          <span className="mb-1.5 block text-sm font-bold text-cocoaSoft">表情头像</span>
          <div className="flex flex-wrap gap-2">
            {AVATAR_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => pickEmoji(e)}
                className={`flex h-10 w-10 items-center justify-center rounded-full text-xl transition ${
                  emoji === e && mode !== 'image' ? 'bg-blush/20 ring-2 ring-blush' : 'bg-cream'
                }`}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        <Field label="你的昵称">
          <TextInput value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={12} />
        </Field>

        {/* 性别：点选切换，再点一次取消选择 */}
        <div>
          <span className="mb-1.5 block text-sm font-bold text-cocoaSoft">性别</span>
          <div className="flex gap-2">
            {[
              { key: 'male', label: '♂ 男生' },
              { key: 'female', label: '♀ 女生' },
            ].map((g) => (
              <button
                key={g.key}
                type="button"
                onClick={() => setGender((cur) => (cur === g.key ? null : g.key))}
                className={`flex-1 rounded-full py-2.5 text-sm font-bold transition active:scale-95 ${
                  gender === g.key
                    ? g.key === 'male'
                      ? 'bg-[#7EB6FF] text-white shadow-card'
                      : 'bg-blush text-white shadow-card'
                    : 'bg-cream text-cocoaSoft'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-cocoaSoft/70">男生会看到蓝色主题，女生是粉色；点选可即时预览，功能也会按性别展示</p>
        </div>

        <Field label="所在城市（可选）">
          <TextInput value={city} onChange={(e) => setCity(e.target.value)} maxLength={20} placeholder="如 北京 / 上海 / 伦敦…" />
        </Field>

        {error && (
          <p className="rounded-xl bg-peach/30 px-4 py-2 text-sm font-semibold text-rosy">{error}</p>
        )}

        <Button className="w-full" onClick={save} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </Modal>

      {/* 裁剪弹窗：嵌套在编辑资料之上（同 z-index，DOM 靠后者在上层） */}
      {pendingPick && (
        <AvatarCropper
          file={pendingPick.file}
          open={cropperOpen}
          onCancel={handleCropCancel}
          onConfirm={handleCropped}
        />
      )}
    </>
  )
}
