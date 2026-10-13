import { useEffect, useRef, useState } from 'react'
import { Modal, Button } from './ui.jsx'
import { toast } from '../lib/toast.jsx'

// 头像裁剪器：不引第三方库（包体和跨境加载都友好），手写「拖动 + 缩放 + 旋转」。
// 交互：初始显示整张照片（contain），拖动平移；双指捏合 / 滚轮 / 滑杆缩放；90° 旋转。
// 裁剪圆直径自适应照片宽高比（圆正好内切于照片短边），缩小下限 = 整张照片可见，
// 避免「竖拍人像一进来脸就占满圆框」的自动放大问题。
// 输出 512×512 正方形 JPEG（展示端由 CSS 圆形裁切），确认后回传 File 给调用方上传。
const OUT = 512 // 导出边长
const MIN_FACTOR = 8 // 最大放大倍数下限（相对「整图可见」的最小缩放）

// scale=1 时，旋转 r 度后图片的包围盒（90/270 度时宽高互换）
function boundsOf(dim, r) {
  const swap = r % 180 !== 0
  return { bw: swap ? dim.ih : dim.iw, bh: swap ? dim.iw : dim.ih }
}

// 裁剪圆直径：= 包含图（contain）的短边。旋转不影响（min/max 互换后比值不变）
function cropD(dim, r, v) {
  const { bw, bh } = boundsOf(dim, r)
  return (v * Math.min(bw, bh)) / Math.max(bw, bh)
}

// 缩放下限 = 整张照片完整可见（contain：s = V / 长边），
// 此时照片短边恰好等于裁剪圆直径，圆正好被照片盖住
function minScaleOf(dim, r, v) {
  const { bw, bh } = boundsOf(dim, r)
  return v / Math.max(bw, bh)
}

// 缩放上限：至少 MIN_FACTOR 倍；照片极扁/极长时再放宽，保证能放大到填满圆
function maxScaleOf(dim, r, v) {
  const min = minScaleOf(dim, r, v)
  return min * Math.max(MIN_FACTOR, (v / cropD(dim, r, v)) * 1.5)
}

function clampS(dim, r, v, s) {
  return Math.min(Math.max(s, minScaleOf(dim, r, v)), maxScaleOf(dim, r, v))
}

// 平移范围：旋转后的包围盒必须始终盖住中央的裁剪圆（直径 d），
// 即图片中心距取景框中心不超过 (bw·s − d)/2。短轴方向余量为 0 时锁死在中心
function clampC(dim, r, v, s, cx, cy) {
  const { bw, bh } = boundsOf(dim, r)
  const d = cropD(dim, r, v)
  return {
    cx: Math.min(Math.max(cx, v / 2 - (bw * s - d) / 2), v / 2 + (bw * s - d) / 2),
    cy: Math.min(Math.max(cy, v / 2 - (bh * s - d) / 2), v / 2 + (bh * s - d) / 2),
  }
}

export default function AvatarCropper({ file, open, onCancel, onConfirm }) {
  const boxRef = useRef(null)
  const imgRef = useRef(null)
  const gesture = useRef(null) // 当前手势快照（手指位置、手势开始时的取景状态）
  const [url, setUrl] = useState('')
  const [V, setV] = useState(288) // 取景框边长；jsdom / 测量异常时保底
  const [dim, setDim] = useState(null) // { iw, ih } 自然尺寸（浏览器已按 EXIF 摆正）
  const [rot, setRot] = useState(0) // 0 | 90 | 180 | 270
  const [view, setView] = useState(null) // { s, cx, cy } 图片中心在取景框中的位置与缩放

  // 组件自管 objectURL：换图 / 卸载时释放
  useEffect(() => {
    if (!file) return
    const u = window.URL.createObjectURL(file)
    setUrl(u)
    return () => window.URL.revokeObjectURL(u)
  }, [file])

  // 测量取景框实际尺寸（响应式）
  useEffect(() => {
    if (!open) return
    const measure = () => {
      const w = boxRef.current?.offsetWidth
      if (w > 0) setV(w)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])

  // 每次打开 / 换图：回到初始状态
  useEffect(() => {
    if (!open) return
    setRot(0)
    setView(null)
  }, [open, url])

  // 图片加载完成：记录自然尺寸
  const onLoad = (e) => {
    const img = e.currentTarget
    if (img.naturalWidth && img.naturalHeight) {
      setDim({ iw: img.naturalWidth, ih: img.naturalHeight })
    }
  }

  // 初始化取景 / 旋转后重新夹紧 / 窗口尺寸变化后重新夹紧
  useEffect(() => {
    if (!dim || !V) return
    setView((cur) => {
      const min = minScaleOf(dim, rot, V)
      if (!cur) return { s: min, ...clampC(dim, rot, V, min, V / 2, V / 2) }
      const s = clampS(dim, rot, V, cur.s)
      return { s, ...clampC(dim, rot, V, s, cur.cx, cur.cy) }
    })
  }, [dim, V, rot])

  // 缩放到指定倍率，保持 m 点下的图像内容不动
  const zoomAt = (ns, m) => {
    if (!dim || !V) return
    setView((cur) => {
      if (!cur) return cur
      const s = clampS(dim, rot, V, ns)
      const k = 1 - s / cur.s
      const c = clampC(dim, rot, V, s, cur.cx + k * (m.x - cur.cx), cur.cy + k * (m.y - cur.cy))
      return { s, ...c }
    })
  }

  // 滚轮缩放。React 合成 wheel 事件是 passive 的，preventDefault 无效，
  // 所以这里挂原生监听（preventDefault 阻止页面跟随滚动）
  useEffect(() => {
    const box = boxRef.current
    if (!box || !open) return
    const h = (e) => {
      e.preventDefault()
      const rect = box.getBoundingClientRect()
      zoomAt((view?.s || 1) * Math.exp(-e.deltaY * 0.0015), {
        x: e.clientX - (rect.left || 0),
        y: e.clientY - (rect.top || 0),
      })
    }
    box.addEventListener('wheel', h, { passive: false })
    return () => box.removeEventListener('wheel', h)
  }, [open, view, dim, rot, V])

  // 屏幕坐标 → 取景框内坐标
  const local = (e) => {
    const rect = boxRef.current?.getBoundingClientRect()
    return { x: e.clientX - (rect?.left || 0), y: e.clientY - (rect?.top || 0) }
  }

  const onPointerDown = (e) => {
    if (!view || !dim) return
    const pid = e.pointerId ?? 1
    try {
      e.currentTarget.setPointerCapture?.(pid)
    } catch {
      /* jsdom 等环境可能不支持，忽略 */
    }
    const pt = local(e)
    const g = gesture.current
    if (!g) {
      gesture.current = { pts: new Map([[pid, pt]]), base: { ...view }, start: pt, dist0: 0, mid0: pt }
    } else {
      // 第二根手指落下：以当前状态为基准，进入捏合模式
      g.pts.set(pid, pt)
      const [a, b] = [...g.pts.values()]
      g.dist0 = Math.hypot(a.x - b.x, a.y - b.y) || 1
      g.mid0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      g.base = { ...view }
    }
  }

  const onPointerMove = (e) => {
    const g = gesture.current
    if (!g || !dim || !V) return
    const pid = e.pointerId ?? 1
    if (!g.pts.has(pid)) return
    const pt = local(e)
    g.pts.set(pid, pt)
    if (g.pts.size >= 2) {
      // 双指捏合：距离比例 → 缩放，中点位移 → 平移
      const [a, b] = [...g.pts.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const s = clampS(dim, rot, V, g.base.s * (dist / g.dist0))
      const k = 1 - s / g.base.s
      const c = clampC(
        dim,
        rot,
        V,
        s,
        g.base.cx + (mid.x - g.mid0.x) + k * (g.mid0.x - g.base.cx),
        g.base.cy + (mid.y - g.mid0.y) + k * (g.mid0.y - g.base.cy),
      )
      setView({ s, ...c })
    } else {
      // 单指拖动
      const c = clampC(dim, rot, V, g.base.s, g.base.cx + (pt.x - g.start.x), g.base.cy + (pt.y - g.start.y))
      setView({ s: g.base.s, ...c })
    }
  }

  const onPointerUp = (e) => {
    const g = gesture.current
    if (!g) return
    const pid = e.pointerId ?? 1
    g.pts.delete(pid)
    if (g.pts.size === 1) {
      // 双指变单指：以剩余手指为新基准，继续拖动
      const [p] = [...g.pts.values()]
      g.base = { ...view }
      g.start = p
      g.dist0 = 0
      g.mid0 = p
    } else if (g.pts.size === 0) {
      gesture.current = null
    }
  }

  // 缩放滑杆（以取景框中心为锚点）
  const minS = dim && V ? minScaleOf(dim, rot, V) : 1
  const maxFactor = dim && V ? maxScaleOf(dim, rot, V) / minS : 1
  const sliderVal = view ? Math.round((Math.log(view.s / minS) / Math.log(maxFactor)) * 100) : 0
  const onSlider = (e) => {
    const x = Number(e.target.value)
    zoomAt(minS * Math.pow(maxFactor, x / 100), { x: V / 2, y: V / 2 })
  }

  const rotate = () => setRot((r) => (r + 90) % 360)

  // 重置：回到初始整图可见（含旋转一起归零，误操作后一键从头再来）
  const reset = () => {
    if (!dim || !V) return
    setRot(0)
    const min = minScaleOf(dim, 0, V)
    setView({ s: min, ...clampC(dim, 0, V, min, V / 2, V / 2) })
  }

  // 导出：所见即所得。
  // 不再用 ctx 变换栈叠加（translate/rotate/scale 逐层变换在个别环境不可靠），
  // 而是：①取景参数直接从预览 <img> 的内联样式读回（用户看到什么就是什么）；
  // ②把圆区四角用 R⁻¹ 映射回内容坐标（90° 倍数下仍是轴对齐正方形）→ 原图源矩形；
  // ③rot=0 用 9 参 drawImage 一次成型，rot≠0 先在临时画布把图转正再 9 参裁剪。
  const confirm = () => {
    const img = imgRef.current
    if (!view || !dim || !img) return
    try {
      // ① 读回预览取景（回退 React 状态）
      let s = view.s
      let cx = view.cx
      let cy = view.cy
      let r = rot
      try {
        const m = (img.style.transform || '').match(
          /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*rotate\(([-\d.]+)deg\)\s*scale\(([\d.]+)\)/,
        )
        if (m) {
          cx = +m[1] + parseFloat(img.style.width) / 2
          cy = +m[2] + parseFloat(img.style.height) / 2
          r = ((+m[3] % 360) + 360) % 360
          s = +m[4]
        }
      } catch {
        /* 解析失败回退状态 */
      }

      const cd = cropD(dim, r, V)
      const co = (V - cd) / 2

      // ② 圆区四角（取景坐标 p）→ 内容坐标 q = R⁻¹·(p−c)/s
      const inv = (x, y) => {
        if (r === 90) return [y, -x]
        if (r === 180) return [-x, -y]
        if (r === 270) return [-y, x]
        return [x, y]
      }
      const corners = [
        inv((co - cx) / s, (co - cy) / s),
        inv((co + cd - cx) / s, (co - cy) / s),
        inv((co - cx) / s, (co + cd - cy) / s),
        inv((co + cd - cx) / s, (co + cd - cy) / s),
      ]
      const xs = corners.map((c) => c[0])
      const ys = corners.map((c) => c[1])
      const qx0 = Math.min(...xs)
      const qy0 = Math.min(...ys)
      const sw = Math.max(...xs) - qx0
      const sh = Math.max(...ys) - qy0

      // ③ 源矩形（像素）：rot=0 直接裁原图；否则先转正到临时画布
      const { bw, bh } = boundsOf(dim, r)
      let src = img
      let halfW = dim.iw / 2
      let halfH = dim.ih / 2
      if (r !== 0) {
        const tmp = document.createElement('canvas')
        tmp.width = bw
        tmp.height = bh
        const tctx = tmp.getContext('2d')
        tctx.translate(bw / 2, bh / 2)
        tctx.rotate((r * Math.PI) / 180)
        tctx.drawImage(img, -dim.iw / 2, -dim.ih / 2, dim.iw, dim.ih)
        src = tmp
        halfW = bw / 2
        halfH = bh / 2
      }
      const sx = qx0 + halfW
      const sy = qy0 + halfH
      if (!(s > 0 && sw > 0 && sh > 0)) throw new Error('裁剪参数异常')

      const canvas = document.createElement('canvas')
      canvas.width = OUT
      canvas.height = OUT
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas 不可用')
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.fillStyle = '#ffffff' // PNG 透明底转 JPEG 会变黑，先铺白底
      ctx.fillRect(0, 0, OUT, OUT)
      ctx.drawImage(src, sx, sy, sw, sh, 0, 0, OUT, OUT)
      console.info('[avatar] 导出参数', { s, cx, cy, r, d: cd, sx, sy, sw, sh })
      canvas.toBlob((blob) => {
        if (!blob) return
        onConfirm?.(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }))
      }, 'image/jpeg', 0.9)
    } catch (err) {
      console.warn('[avatar] 裁剪失败：', err?.message)
      toast.error('头像裁剪失败：' + (err?.message || '换一张图片试试'))
      onCancel?.()
    }
  }

  // 裁剪圆的直径与左上角位置（图片加载前退化为整个取景框）
  const d = dim && V ? cropD(dim, rot, V) : V
  const o = (V - d) / 2

  const imgStyle =
    dim && view
      ? {
          width: `${dim.iw}px`,
          height: `${dim.ih}px`,
          transform: `translate(${view.cx - dim.iw / 2}px, ${view.cy - dim.ih / 2}px) rotate(${rot}deg) scale(${view.s})`,
        }
      : { visibility: 'hidden' }

  return (
    <Modal open={open} onClose={onCancel} title="裁剪头像">
      <div className="space-y-4">
        <div
          ref={boxRef}
          data-testid="crop-box"
          className="relative mx-auto aspect-square w-72 max-w-full touch-none select-none overflow-hidden rounded-2xl bg-cocoa/80"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {url && (
            <img
              ref={imgRef}
              src={url}
              alt="裁剪预览"
              draggable={false}
              onLoad={onLoad}
              className="absolute left-0 top-0 max-w-none"
              style={imgStyle}
            />
          )}
          {/* 圆形遮罩：圆外压暗（含照片露出的部分），圆内就是最终头像的效果 */}
          <div className="pointer-events-none absolute inset-0">
            <div
              className="absolute rounded-full shadow-[0_0_0_9999px_rgba(60,40,35,0.55)]"
              style={{ left: o, top: o, width: d, height: d }}
            />
            <div
              className="absolute rounded-full ring-2 ring-white/70"
              style={{ left: o, top: o, width: d, height: d }}
            />
          </div>
          {!view && (
            <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-white/80">
              图片加载中…
            </div>
          )}
        </div>

        <p className="text-center text-xs font-semibold text-cocoaSoft/70">
          圆内为头像效果 · 拖动调整 · 双指或滑杆缩放，可缩小看整张照片
        </p>

        <div className="flex items-center gap-3 px-1">
          <span className="text-lg">🔍</span>
          <input
            type="range"
            min={0}
            max={100}
            step={0.5}
            value={sliderVal}
            onChange={onSlider}
            className="h-1.5 w-full cursor-pointer accent-blush"
            aria-label="缩放"
          />
        </div>

        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={reset} disabled={!view}>
            ↺ 复位
          </Button>
          <Button variant="ghost" className="flex-1" onClick={rotate}>
            旋转
          </Button>
          <Button variant="ghost" className="flex-1" onClick={onCancel}>
            取消
          </Button>
          <Button className="flex-1" onClick={confirm} disabled={!view}>
            完成
          </Button>
        </div>
      </div>
    </Modal>
  )
}
