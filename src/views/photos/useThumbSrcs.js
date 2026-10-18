// 缩略图签名：网格 / 图集封面 / 回收站 / 选择态预览共用一个取图入口。
// 从 Photos.jsx 抽出，单独放这里是为了把「只加载缩略图」这条规则钉死在一处。
//
// 两条来源：
// 1. 有 thumb_path → 批量签真实缩略图文件（一次请求签一批，480px 几十 KB）
// 2. 没 thumb_path（024 之前的旧照片）→ 单签「480 cover 变换」，变换在 Storage 服务端完成，
//    手机上同样只下几十 KB。以前这里是直接签 storage_path —— 一张老照片就是几 MB，必须堵掉。
//
// 原图（storage_path / original_path）只允许出现在灯箱、下载、导出这类**明确操作**里。
import { useEffect, useState } from 'react'
import { signedMediaUrl, useSignedMap } from '../../lib/storage.js'
import { mapLimit } from '../../lib/image.js'
import { thumbPathOf, THUMB_TF } from './constants.js'

// 一次最多补签多少张旧照片：剩下的靠 useThumbBackfill 后台补成真实缩略图后转正。
// 上限存在的意义是「旧照片很多时不要一进页面就打出上百个签名请求」。
const LEGACY_LIMIT = 40
const LEGACY_CONCURRENCY = 4

export function useThumbSrcs(rows) {
  const list = rows || []
  const signed = useSignedMap(
    'photos',
    list.map(thumbPathOf).filter(Boolean),
  )

  // 缺缩略图的旧照片：按 storage_path 拼依赖签名，内容不变就不重签
  const legacySig = list
    .filter((p) => !p.thumb_path)
    .map((p) => p.storage_path)
    .filter(Boolean)
    .join('|')

  const [legacy, setLegacy] = useState({})

  useEffect(() => {
    let alive = true
    const todo = (legacySig ? legacySig.split('|') : []).slice(0, LEGACY_LIMIT)
    if (todo.length === 0) {
      setLegacy((cur) => (Object.keys(cur).length ? {} : cur))
      return
    }
    mapLimit(todo, LEGACY_CONCURRENCY, (p) => signedMediaUrl('photos', p, THUMB_TF)).then((urls) => {
      if (!alive) return
      const next = {}
      todo.forEach((p, i) => {
        if (urls[i]) next[p] = urls[i]
      })
      setLegacy(next)
    })
    return () => {
      alive = false
    }
  }, [legacySig])

  // 返回取图函数（而不是 map）：子组件（网格/封面/回收站）不需要知道背后有几层
  return (p) => {
    if (!p) return ''
    if (p.thumb_path) return signed[p.thumb_path] || ''
    return legacy[p.storage_path] || ''
  }
}

export { LEGACY_LIMIT }
