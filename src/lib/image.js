// 客户端图片压缩：把手机动辄 3~8MB 的原图压到几百 KB 再上传。
// 跨境上传到 Supabase 的瓶颈在文件体积，压缩通常能让速度提升 10 倍以上。

const DEFAULTS = { maxEdge: 1600, quality: 0.82 }

// 把文件或 blob 解码成可绘制对象，自动按 EXIF 摆正方向
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // 某些浏览器不支持该选项，退回到 <img> 解码
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    await new Promise((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('图片解码失败'))
      img.src = url
    })
    return img
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

export function fmtSize(bytes) {
  if (!bytes) return '0KB'
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + 'KB'
  return (bytes / 1024 / 1024).toFixed(1) + 'MB'
}

/**
 * 把 getPublicUrl 得到的公开地址换成 CDN 动态缩图地址（Supabase 图片变换）。
 * 弱网（尤其跨境）下小图的下载成功率和速度都好一个数量级；旧照片无需迁移即可受益。
 *
 * ⚠️ 实测端点行为（2026-10，头像放大 bug 的根因）：
 * - 只传 width：输出「宽=width、高=原高」的拉伸图（不保比例！512² 方图会变 96×512 细条）
 * - width + height + resize=cover：精确裁剪成 width×height（方形容器用这个）
 * - width + height + resize=contain：等比适配包围盒内，不加留边、不放大（保比例全览用这个）
 * 所以任何展示点都必须同时传 height + resize，否则图片会被拉变形。
 *
 * @param {string} publicUrl getPublicUrl().data.publicUrl
 * @param {number} width 目标宽度 px
 * @param {number} quality 0-100
 * @param {{ height?: number, resize?: 'cover'|'contain' }} [opts] 必传！见上
 */
export function withTransform(publicUrl, width, quality = 75, opts = {}) {
  if (!publicUrl) return publicUrl
  const { height, resize } = opts
  let params = `width=${width}`
  if (height) params += `&height=${height}`
  if (resize) params += `&resize=${resize}`
  params += `&quality=${quality}`
  return publicUrl.replace('/object/public/', '/render/image/public/') + `?${params}`
}

/**
 * 压缩单张图片。任何一步失败都会安全退回原图，绝不阻塞上传。
 * @returns {Promise<{ file: File, before: number, after: number }>}
 */
export async function compressImage(file, options = {}) {
  const { maxEdge, quality } = { ...DEFAULTS, ...options }
  const before = file.size
  try {
    const source = await decode(file)
    const sw = source.width || source.naturalWidth
    const sh = source.height || source.naturalHeight
    if (!sw || !sh) throw new Error('无法读取图片尺寸')

    const scale = Math.min(1, maxEdge / Math.max(sw, sh))
    const w = Math.max(1, Math.round(sw * scale))
    const h = Math.max(1, Math.round(sh * scale))

    // 已经很小且不需要缩放时，直接传原图，省一次重编码
    if (scale === 1 && before < 300 * 1024) {
      if (source.close) source.close()
      return { file, before, after: before }
    }

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 不可用')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    // 透明 PNG 转 JPEG 会变黑，先铺白底
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(source, 0, 0, w, h)
    if (source.close) source.close()

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    canvas.width = 0
    canvas.height = 0
    if (!blob || blob.size >= before) return { file, before, after: before }

    const name = (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg'
    const out = new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() })
    return { file: out, before, after: out.size }
  } catch (e) {
    console.warn('[image] 压缩失败，改用原图：', e && e.message)
    return { file, before, after: before }
  }
}

/**
 * 把一张远端图片保存到本机 / 手机相册。
 * 手机上优先走系统分享（iOS 可直接「存储到照片」，Android 可存到相册/文件），
 * 桌面浏览器回退到 <a download>，两者都不行就新开标签让用户长按保存。
 * @returns {Promise<'shared'|'downloaded'|'opened'>}
 */
export async function saveImage(url, filename) {
  const isAbort = (e) => e && (e.name === 'AbortError' || e.name === 'NotAllowedError')
  let blob = null
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    blob = await res.blob()
  } catch {
    // 跨域或网络失败：新窗口打开，手机上长按图片即可存相册
    window.open(url, '_blank', 'noopener')
    return 'opened'
  }

  const name = filename || 'photo.jpg'
  const file = new File([blob], name, { type: blob.type || 'image/jpeg' })

  // 系统分享：手机上这一步能直接存进相册
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name })
      return 'shared'
    }
  } catch (e) {
    if (isAbort(e)) return 'shared' // 用户主动取消，不算失败
  }

  try {
    const link = document.createElement('a')
    link.href = window.URL.createObjectURL(blob)
    link.download = name
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    setTimeout(() => {
      window.URL.revokeObjectURL(link.href)
      link.remove()
    }, 1000)
    return 'downloaded'
  } catch {
    window.open(url, '_blank', 'noopener')
    return 'opened'
  }
}

/**
 * 限制并发地处理一组任务，避免一次开太多连接反而变慢。
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      try {
        results[i] = await worker(items[i], i)
      } catch (e) {
        console.error('[mapLimit] 任务失败：', e)
        results[i] = null
      }
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 批量静默下载（Android / 桌面）：fetch → a[download] 逐张触发，不弹系统面板、不开新窗口。
 * iOS 上 a[download] 只能进「文件」App 而不是相册，所以 iOS 用逐张 share 弹窗（见 Photos）。
 * @param {Array<{url: string, filename?: string}>} items
 * @param {({done:number,total:number}) => void} [onProgress]
 * @returns {Promise<{saved:number, failed:number}>}
 */
export async function downloadImages(items, onProgress) {
  let saved = 0
  let failed = 0
  for (let i = 0; i < items.length; i++) {
    const { url, filename } = items[i] || {}
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const blob = await res.blob()
      const link = document.createElement('a')
      link.href = window.URL.createObjectURL(blob)
      link.download = filename || 'photo.jpg'
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      setTimeout(() => {
        window.URL.revokeObjectURL(link.href)
        link.remove()
      }, 1000)
      saved++
    } catch {
      failed++
    }
    onProgress?.({ done: i + 1, total: items.length })
  }
  return { saved, failed }
}

/** iPhone / iPad（含桌面版 Safari 触屏误判为 Mac 的情况） */
export function isIOSDevice() {
  try {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    )
  } catch {
    return false
  }
}
