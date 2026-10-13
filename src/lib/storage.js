// 私有桶媒体加载：photos / voice 已改为 private bucket，
// 前端一律通过「签名 URL」访问（URL 里带 token，过期自动失效）。
//
// 为什么这么设计：
// - 签名有效期取 Storage 上限 7 天；内存缓存 6 天（宁早重签，不留过期链接）
// - 同一会话同一「文件+变换」只签一次，切页面/翻旧照片不重复请求
// - 网格小图/封面走批量签名（createSignedUrls，一次请求签一批），直接签真实文件，
//   裁切交给 CSS object-cover（等比裁剪不变形；旧版「只传 width 的变换端点会拉伸」的坑不再涉及）
// - 灯箱/大图走单文件按需签名 + 图片变换（contain 等比适配，不放大不加边），
//   避免把几 MB 的原图直接怼进手机流量
import { useEffect, useState } from 'react'
import { supabase } from './supabase.js'

const TTL = 60 * 60 * 24 * 7 // 签名有效期（Storage 允许的上限）
const CACHE_TTL_MS = 60 * 60 * 24 * 6 * 1000 // 内存缓存 6 天
const cache = new Map() // key → { url, exp }

const keyOf = (bucket, path, transform) => `${bucket}|${path}|${transform ? JSON.stringify(transform) : ''}`
const abs = (u) => (u && u.startsWith('http') ? u : `${supabase.storage.url}${u}`)

function putCache(bucket, path, transform, url) {
  cache.set(keyOf(bucket, path, transform), { url, exp: Date.now() + CACHE_TTL_MS })
}

// 签名失败后清掉缓存（比如策略调整后旧 token 失效，下次重签）
export function invalidateSignedUrl(bucket, path, transform = null) {
  cache.delete(keyOf(bucket, path, transform))
}

/**
 * 单文件签名 URL。transform 传 { height, resize } 时返回「变换后」的签名地址
 * （等价于旧版 render 端点，但走 sign 通道，私有桶也能用）。
 */
export async function signedMediaUrl(bucket, path, transform = null) {
  if (!path) return ''
  const hit = cache.get(keyOf(bucket, path, transform))
  if (hit && hit.exp > Date.now()) return hit.url
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, TTL, transform ? { transform } : undefined)
  if (error || !data?.signedUrl) {
    console.error('[storage] 签名 URL 失败：', bucket, path, error?.message || '')
    return ''
  }
  const url = abs(data.signedUrl)
  putCache(bucket, path, transform, url)
  return url
}

/**
 * 批量签名（不支持变换）：一次请求签一批真实文件，返回 Map(path → url)。
 * 失败的文件不出现在结果里（调用方拿不到 url 就先不渲染）。
 */
export async function signedMediaUrls(bucket, paths) {
  const uniq = [...new Set(paths.filter(Boolean))]
  const out = new Map()
  const missing = []
  for (const p of uniq) {
    const hit = cache.get(keyOf(bucket, p, null))
    if (hit && hit.exp > Date.now()) out.set(p, hit.url)
    else missing.push(p)
  }
  if (missing.length > 0) {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(missing, TTL)
    if (error) {
      console.error('[storage] 批量签名失败：', bucket, error.message)
      return out
    }
    for (const row of data || []) {
      const raw = row?.signedUrl || row?.signedURL
      if (!raw || row?.error) continue
      const full = abs(raw)
      cache.set(keyOf(bucket, row.path, null), { url: full, exp: Date.now() + CACHE_TTL_MS })
      out.set(row.path, full)
    }
  }
  return out
}

/**
 * 孤儿文件清理：数据库没写进去时，把本批已上传的文件撤回（防桶里留下没人引用的文件）。
 * 桶不限（photos / voice 都能用），路径去重并过滤空值。
 * Storage 的 remove 对不存在的路径不报错，重复调用安全。
 *
 * 返回 { error }：调用方**必须**据此提示——清理失败却不说，等于把孤儿文件藏起来。
 */
export async function removeUploads(bucket, paths) {
  const list = [...new Set((paths || []).filter(Boolean))]
  if (list.length === 0) return { error: null }
  const { error } = await supabase.storage.from(bucket).remove(list)
  if (error) console.error('[storage] 撤回上传文件失败：', bucket, list, error.message)
  return { error: error || null }
}

/**
 * 组件 hook：单文件签名 → state（带变换的按需签名用这个，比如灯箱大图）。
 * path 为 null/空时返回 ''。
 */
export function useSignedSrc(bucket, path, transform = null) {
  const tfKey = transform ? JSON.stringify(transform) : ''
  const [src, setSrc] = useState('')
  useEffect(() => {
    let alive = true
    if (!path) {
      setSrc('')
      return
    }
    const hit = cache.get(keyOf(bucket, path, tfKey ? JSON.parse(tfKey) : null))
    if (hit && hit.exp > Date.now()) {
      setSrc(hit.url)
      return
    }
    setSrc('')
    signedMediaUrl(bucket, path, transform).then((u) => {
      if (alive) setSrc(u)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket, path, tfKey])
  return src
}

/**
 * 组件 hook：批量签名 → Map(path → url)。
 * paths 内容稳定时不会重复请求（内部用 join('|') 做依赖签名，无需调用方 useMemo）。
 */
export function useSignedMap(bucket, paths) {
  const [map, setMap] = useState({})
  const sig = (paths || []).join('|')
  useEffect(() => {
    let alive = true
    const list = sig ? sig.split('|') : []
    if (list.length === 0) {
      setMap((cur) => (Object.keys(cur).length ? {} : cur))
      return
    }
    signedMediaUrls(bucket, list).then((m) => {
      if (alive) setMap(Object.fromEntries(m))
    })
    return () => {
      alive = false
    }
  }, [bucket, sig])
  return map
}
