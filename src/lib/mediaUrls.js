// 图片 URL 的公共约定：三档各管一段，谁都不许越界。
//
//   480 缩略图 → 列表 / 卡片 / 封面 / 回收站（一屏十几张，必须小）
//   1280 预览图 → 灯箱（单张，可以大一点）
//   原图（original_path）→ 保存 / 下载 / 导出，平时绝不出现在 <img> 的加载路径里
//
// 480 与 1280 都是 Storage 服务端的图片变换（imgproxy）：
//   · 必须带 height + resize，只传 width 会被拉伸变形（lib/image.js 的老坑）
//   · cover 用于裁成方图（网格），contain 用于等比适配（灯箱，不放大不加边）
import { useEffect, useState } from 'react'
import { signedMediaUrl } from './storage.js'
import { mapLimit } from './image.js'

export const THUMB_TF = { width: 480, height: 480, resize: 'cover' }
export const PREVIEW_TF = { height: 1280, resize: 'contain' }

// 一次最多签多少张 / 几并发：
// 留言/日记首屏图不多，但旧数据可能一大堆，别一进页面就打出上百个签名请求。
// ⚠ 这是**分批大小，不是上限**：签完一批先落到画面上，再继续签下一批，一路签到底。
//   之前写成 slice(0, 40)（硬上限），日记 18 条 × 3 张 = 54 张时第 41 张往后永远停在
//   占位状态，翻页也只会重新算前 40 条 —— 那是把「限流」写成了「丢数据」。
const THUMB_CHUNK = 24
const THUMB_CONCURRENCY = 4

/**
 * 一批图 → 480 缩略图 URL（{ [path]: url }）。
 * 留言配图 / 日记配图没有单独的缩略图文件，直接签原路径会把 1280 的图塞进小卡片里
 * —— 这里统一走服务端 480 变换，卡片上只下几十 KB。
 * 内容不变就不重签（内部用路径列表做依赖签名，调用方不用 useMemo）。
 */
export function useThumbUrls(bucket, paths) {
  const [map, setMap] = useState({})
  const sig = (paths || []).join('|')
  useEffect(() => {
    let alive = true
    const list = (sig ? sig.split('|') : []).filter(Boolean)
    if (list.length === 0) {
      setMap((cur) => (Object.keys(cur).length ? {} : cur))
      return
    }
    ;(async () => {
      for (let i = 0; i < list.length; i += THUMB_CHUNK) {
        if (!alive) return
        const batch = list.slice(i, i + THUMB_CHUNK)
        const urls = await mapLimit(batch, THUMB_CONCURRENCY, (p) => signedMediaUrl(bucket, p, THUMB_TF))
        if (!alive) return
        const next = {}
        batch.forEach((p, k) => {
          if (urls[k]) next[p] = urls[k]
        })
        // 累加而不是替换：翻页带来新一批图时，已经显示出来的那些不该被冲成空 URL
        setMap((cur) => ({ ...cur, ...next }))
      }
    })()
    return () => {
      alive = false
    }
  }, [bucket, sig])
  return map
}

/**
 * 灯箱大图：返回 { preview(1280), full(原尺寸) } 两个签名 URL。
 * 两个一起交给 srcset，浏览器按 sizes 自己挑 —— 手机 DPR2 只要 1280，
 * 桌面大屏才可能用到未变换的那档；都不必去碰几 MB 的原图。
 *
 * ⚠ 顺序很重要：**预览图先签先显示，原图那一档随后再补**。
 * 两条一起 Promise.all 的话，手机上实际只用到 1280，却要等「原图签名」这个
 * 完全用不上的请求回来才能出图 —— 白白的等待时间。现在 preview 一到就先 set，
 * full 到不了也不影响看图（srcset 自动退化成单图）。
 */
export function useViewerSrcs(bucket, path) {
  const [srcs, setSrcs] = useState({ preview: '', full: '' })
  useEffect(() => {
    let alive = true
    if (!path) {
      setSrcs((cur) => (cur.preview || cur.full ? { preview: '', full: '' } : cur))
      return
    }
    setSrcs({ preview: '', full: '' })
    signedMediaUrl(bucket, path, PREVIEW_TF)
      .then(async (preview) => {
        if (!alive) return
        if (preview) setSrcs({ preview, full: '' })
        else setSrcs({ preview: '', full: '' })
        if (!preview) return
        // 高分屏才用得上，慢一拍完全没问题；失败就留空，页面照常显示 1280 那张
        const full = await signedMediaUrl(bucket, path, null)
        if (alive && full) setSrcs((cur) => ({ ...cur, full }))
      })
      .catch(() => {
        /* 签名失败：保持空 src，SmartImg 会给出占位 */
      })
    return () => {
      alive = false
    }
  }, [bucket, path])
  return srcs
}

/** 把灯箱的两档拼成 srcset（缺任何一档就不给 srcset，退回单图） */
export function viewerSrcSet({ preview, full }) {
  if (!preview || !full) return ''
  return `${preview} 1280w, ${full} 1600w`
}

// 灯箱是「一屏一张」，宽度基本就是视口宽
export const VIEWER_SIZES = '92vw'
