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
//
// 缓存为什么要跨会话（落到 localStorage）：
//   签名 URL 的 token 里带过期时间，**同一文件每次签出来的 URL 都不一样**。
//   而浏览器缓存是按完整 URL 当 key 的 —— URL 一变就是 miss，图得重新下载一遍。
//   所以这条链路的关键不是缓存头，而是「让签出来的 URL 能被复用」：
//   跨会话复用 URL → 签名请求省掉，图片也命中本地缓存，重开页面基本不再走网络。
//   ⚠ 绝不把签名 URL 写进 Service Worker：SW 里存的是完整的跨域响应，token 会跟着
//     被长期留存，等于绕过了 7 天有效期。落 localStorage 的一律带 exp，过期自动丢。
import { useEffect, useState } from 'react'
import { supabase } from './supabase.js'

const TTL = 60 * 60 * 24 * 7 // 签名有效期（Storage 允许的上限）
const CACHE_TTL_MS = 60 * 60 * 24 * 6 * 1000 // 缓存 6 天（宁早重签，不留过期链接）

// 跨会话存储
const STORE_KEY = 'love.sign.v1'
const STORE_MAX = 300 // 最多留 300 条（约 80KB），超了丢最旧的
const STORE_DEBOUNCE = 300 // 合并写盘：一次签一批只落一次盘

const cache = new Map() // key → { url, exp }

const keyOf = (bucket, path, transform) => `${bucket}|${path}|${transform ? JSON.stringify(transform) : ''}`
const abs = (u) => (u && u.startsWith('http') ? u : `${supabase.storage.url}${u}`)

// localStorage 在隐私模式下「读一下」都可能抛，取句柄这步就得防
const area = () => {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

// ---------- 跨会话读写 ----------

// 开页面时把上次存下来的 URL 直接灌进内存：首屏就能用，不用等签名往返
function loadStore() {
  const ls = area()
  if (!ls) return
  try {
    const raw = ls.getItem(STORE_KEY)
    if (!raw) return
    const now = Date.now()
    for (const [k, v] of Object.entries(JSON.parse(raw))) {
      if (v && v.url && v.exp > now) cache.set(k, { url: v.url, exp: v.exp })
    }
  } catch {
    /* 存的内容坏了就当没有缓存 */
  }
}

function flushStore() {
  const ls = area()
  if (!ls) return
  const now = Date.now()
  // Map 保持插入顺序（重写已有键不挪位），超上限就丢最早写进去的那些
  const keep = [...cache.entries()].filter(([, v]) => v.exp > now).slice(-STORE_MAX)
  try {
    if (keep.length === 0) ls.removeItem(STORE_KEY)
    else ls.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(keep)))
  } catch {
    /* 配额满了 / 隐私模式：存不下就算了，退回到纯内存缓存 */
  }
}

let storeTimer = null
function scheduleStore() {
  if (storeTimer) return
  storeTimer = setTimeout(() => {
    storeTimer = null
    flushStore()
  }, STORE_DEBOUNCE)
}

// 关页面/切后台时立刻落盘：不然最后 300ms 内签的 URL 会丢
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pagehide', flushStore)
}

loadStore()

function putCache(bucket, path, transform, url) {
  cache.set(keyOf(bucket, path, transform), { url, exp: Date.now() + CACHE_TTL_MS })
  scheduleStore()
}

// 签名失败后清掉缓存（比如策略调整后旧 token 失效，下次重签）
export function invalidateSignedUrl(bucket, path, transform = null) {
  cache.delete(keyOf(bucket, path, transform))
  scheduleStore()
}

/** 测试用：清空内存 + 本地的签名缓存，避免上一条用例签过的 URL 影响下一条 */
export function clearSignedUrlCache() {
  cache.clear()
  if (storeTimer) {
    clearTimeout(storeTimer)
    storeTimer = null
  }
  const ls = area()
  if (ls) {
    try {
      ls.removeItem(STORE_KEY)
    } catch {
      /* 同上 */
    }
  }
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
