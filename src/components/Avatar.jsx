import { supabase } from '../lib/supabase.js'
import { withTransform } from '../lib/image.js'
import SmartImg from './SmartImg.jsx'

const SIZES = {
  sm: { cls: 'h-6 w-6 text-base', px: 96 },
  md: { cls: 'h-10 w-10 text-xl', px: 128 },
  lg: { cls: 'h-14 w-14 text-2xl', px: 192 },
}

// 统一头像渲染：有 avatar_path 显示图片，否则回退到 emoji。
// 图片走 Supabase CDN 动态缩图（弱网/跨境下小图快很多），
// 变换端点偶发失败时 SmartImg 自动降级：去参原图 → 防缓存原图 → 占位。
export function Avatar({ member, size = 'md', className = '' }) {
  const emoji = member?.emoji || '💕'
  const info = SIZES[size] || SIZES.md
  const raw = member?.avatar_path
    ? supabase.storage.from('avatars').getPublicUrl(member.avatar_path).data.publicUrl
    : null
  // 头像源图恒为方图（裁剪器导出 512×512）：必须 width+height+cover 才是精确方图，
  // 只传 width 会被端点拉伸成细长条，object-cover 一裁就是「放大局部」（已踩坑）
  const url = raw ? withTransform(raw, info.px, 80, { height: info.px, resize: 'cover' }) : raw
  const cls = `${info.cls} ${className}`

  if (url) {
    return <SmartImg src={url} alt="" className={`${cls} shrink-0 rounded-full object-cover`} />
  }
  return <span className={`${cls} inline-flex shrink-0 items-center justify-center`}>{emoji}</span>
}
