// 头像裁剪上传冒烟测试
// 覆盖：选图→裁剪器打开→初始整图可见（contain）→拖动/边界钳制→旋转→滑杆缩放→滚轮→
//       双指捏合→复位→完成导出（9 参 drawImage，源矩形由预览取景反推，无变换栈）→
//       上传并清理旧头像→取消不影响已有预览
// 数学：800×600、V=288 → minScale=0.36（整图可见）、裁剪圆 D=216、圆偏移 o=36
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')

let pass = 0
const failures = []
const ok = (cond, name) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    failures.push(name)
    console.log('  ✗', name)
  }
}

// ---------- stub 源码 ----------
const supaStub = `
export const supabase = globalThis.__SUPA__
`
const storeStub = `
export function StoreProvider({ children }) { return children }
export function useStore() { return globalThis.__STORE__ }
`

// ---------- supabase stub ----------
const me = { id: 'u1' }
const memberRow = {
  id: 'm1', couple_id: 'c1', user_id: 'u1', nickname: '小明', emoji: '💕',
  gender: null, avatar_path: 'old-avatar.jpg',
}
const membersDb = [memberRow]
let lastUpdate = null
const uploaded = []
const removed = []

const chain = (table) => {
  const q = {
    update(payload) {
      q._payload = payload
      return q
    },
    eq(col, val) {
      q._eq = [col, val]
      lastUpdate = { table, payload: q._payload, eq: [col, val] }
      if (table === 'members') {
        const row = membersDb.find((r) => r[q._eq[0]] === q._eq[1])
        if (row) Object.assign(row, q._payload)
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
  return q
}

globalThis.__SUPA__ = {
  auth: { getUser: async () => ({ data: { user: me } }) },
  from: (t) => chain(t),
  storage: {
    from: () => ({
      getPublicUrl: (p) => ({ data: { publicUrl: 'http://localhost/storage/v1/object/public/avatars/' + p } }),
      upload: async (p) => {
        uploaded.push(p)
        return { error: null }
      },
      remove: async (paths) => {
        removed.push(...paths)
        return {}
      },
    }),
  },
}
globalThis.__STORE__ = { myMember: memberRow, refresh: async () => {} }

// ---------- bundle ----------
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'avatar-crop.bundle.cjs')
await esbuild.build({
  entryPoints: ['D:/love/src/components/EditProfileModal.jsx'],
  bundle: true,
  format: 'cjs',
  jsx: 'automatic',
  platform: 'node',
  packages: 'external',
  outfile: out,
  plugins: [
    {
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /supabase\.js$/ }, () => ({ path: 'supa-stub', namespace: 'stub' }))
        b.onResolve({ filter: /store\.jsx$/ }, () => ({ path: 'store-stub', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: args.path === 'supa-stub' ? supaStub : storeStub,
          loader: 'js',
        }))
      },
    },
  ],
})

// ---------- jsdom ----------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const { window } = dom
for (const k of ['window', 'document', 'localStorage', 'CustomEvent', 'location', 'requestAnimationFrame', 'getComputedStyle', 'MutationObserver', 'URL', 'File', 'Blob']) {
  if (window[k] !== undefined) globalThis[k] = window[k]
}
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })

// jsdom 没有 objectURL 实现
let urlSeq = 0
window.URL.createObjectURL = () => 'blob:fake-' + ++urlSeq
window.URL.revokeObjectURL = () => {}

// canvas stub：记录 2d 调用序列，toBlob 立即回调
const ctxCalls = []
const ctxStub = {
  fillStyle: '',
  imageSmoothingEnabled: false,
  imageSmoothingQuality: '',
  fillRect(...a) { ctxCalls.push(['fillRect', ...a]) },
  scale(...a) { ctxCalls.push(['scale', ...a]) },
  translate(...a) { ctxCalls.push(['translate', ...a]) },
  rotate(...a) { ctxCalls.push(['rotate', ...a]) },
  drawImage(...a) { ctxCalls.push(['drawImage', ...a]) },
}
window.HTMLCanvasElement.prototype.getContext = function () { return ctxStub }
window.HTMLCanvasElement.prototype.toBlob = function (cb, type) {
  cb(new window.Blob(['x'], { type: type || 'image/jpeg' }))
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const React = require('react')
const ReactDOM = require('react-dom/client')
const EditProfileModal = require(out).default

const root = ReactDOM.createRoot(document.getElementById('root'))
root.render(React.createElement(EditProfileModal, { open: true, onClose: () => {} }))
await tick(80)

const bodyText = () => document.body.textContent
const findBtn = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(text))
const cropBox = () => document.querySelector('[data-testid="crop-box"]')
const cropImg = () => cropBox()?.querySelector('img')
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps

function pickImage(name) {
  const f = new window.File(['img-' + name], name + '.jpg', { type: 'image/jpeg' })
  const input = document.querySelector('input[type="file"]')
  Object.defineProperty(input, 'files', { value: [f], configurable: true })
  input.dispatchEvent(new window.Event('change', { bubbles: true }))
}

function loadImage(w, h) {
  const img = cropImg()
  Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true })
  img.dispatchEvent(new window.Event('load'))
}

// transform 里的 translate 是「图片中心 - 半宽/半高」，要加回去才是取景坐标 cx/cy
const TRANS = /translate\(([-\d.]+)px, ([-\d.]+)px\) rotate\(([-\d.]+)deg\) scale\(([-\d.]+)\)/
const readView = () => {
  const style = cropImg()?.getAttribute('style') || ''
  const m = style.match(TRANS)
  if (!m) return null
  const iw = +(style.match(/width: ([\d.]+)px/) || [])[1] || 0
  const ih = +(style.match(/height: ([\d.]+)px/) || [])[1] || 0
  return { iw, ih, cx: +m[1] + iw / 2, cy: +m[2] + ih / 2, rot: +m[3], s: +m[4] }
}

function pev(type, x, y, id = 1) {
  if (window.PointerEvent) {
    return new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, isPrimary: id === 1 })
  }
  const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
  Object.defineProperty(ev, 'pointerId', { value: id })
  return ev
}

function whev(deltaY, x = 150, y = 150) {
  if (window.WheelEvent) {
    return new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, clientX: x, clientY: y })
  }
  const ev = new window.MouseEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y })
  Object.defineProperty(ev, 'deltaY', { value: deltaY })
  return ev
}

function setSlider(v) {
  const slider = document.querySelector('input[type="range"]')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(slider, String(v))
  slider.dispatchEvent(new window.Event('input', { bubbles: true }))
  slider.dispatchEvent(new window.Event('change', { bubbles: true }))
}

function waitFor(fn, name, tries = 60) {
  return new Promise((resolve) => {
    const go = async (n) => {
      if (fn()) return resolve(true)
      if (n <= 0) {
        failures.push('waitFor: ' + name)
        console.log('  ✗ waitFor 超时:', name)
        return resolve(false)
      }
      await tick(25)
      go(n - 1)
    }
    go(tries)
  })
}

console.log('\n场景 A：选图打开裁剪器，初始整张照片可见（contain，不自动放大）')
pickImage('photo1')
await waitFor(() => bodyText().includes('裁剪头像'), '裁剪弹窗出现')
ok(!!cropBox(), '取景框渲染')
await waitFor(() => cropImg(), '裁剪预览 img 出现')
loadImage(800, 600)
await waitFor(() => readView(), '取景初始化')
let v = readView()
ok(near(v.s, 288 / 800), '初始缩放 = 整图可见(0.36)，而非盖满取景框')
ok(near(v.cx, 144) && near(v.cy, 144), '初始居中(144,144)')
const circle = [...cropBox().querySelectorAll('div')].find((el) => (el.getAttribute('style') || '').includes('width: 216px'))
ok(!!circle, '裁剪圆直径自适应照片比例(216px = 288×600/800)')

console.log('\n场景 B：拖动平移与边界钳制（圆必须始终在照片范围内）')
cropBox().dispatchEvent(pev('pointerdown', 200, 150, 1))
cropBox().dispatchEvent(pev('pointermove', 185, 135, 1))
await tick(20)
v = readView()
ok(near(v.cx, 129) && near(v.cy, 144), '拖动跟随；短轴余量0锁中心(129,144)')
cropBox().dispatchEvent(pev('pointermove', -500, 135, 1))
await tick(20)
v = readView()
ok(near(v.cx, 108) && near(v.cy, 144), '左边界钳制到 108（144-(288-216)/2）')
cropBox().dispatchEvent(pev('pointerup', -500, 135, 1))
await tick(20)

console.log('\n场景 C：旋转 90°（包围盒宽高互换后重新钳制）')
findBtn('旋转').click()
await tick(30)
v = readView()
ok(v.rot === 90, '旋转到 90°')
ok(near(v.cx, 144), '旋转后 cx 锁回中心（旋转后短轴为宽）')
ok(near(v.cy, 144), '旋转后 cy 保持合法值')

console.log('\n场景 D：滑杆缩放到最大（中心为锚点）')
setSlider(100)
await tick(30)
v = readView()
ok(near(v.s, (288 / 800) * 8), '滑杆最大 → 8 倍整图缩放(2.88)')
ok(near(v.cx, 144) && near(v.cy, 144), '中心缩放不改变中心点')

console.log('\n场景 E：滚轮缩放（上限钳制 + 缩小）')
await tick(40) // 等原生 wheel 监听重绑
cropBox().dispatchEvent(whev(-240))
await tick(30)
v = readView()
ok(near(v.s, (288 / 800) * 8), '放大超过上限被钳制')
cropBox().dispatchEvent(whev(240))
await tick(30)
v = readView()
ok(near(v.s, (288 / 800) * 8 * Math.exp(-0.36)), '滚轮缩小生效')

console.log('\n场景 F：双指捏合（距离比例缩放 + 中点位移平移）')
setSlider(0)
await tick(30)
const v0 = readView()
cropBox().dispatchEvent(pev('pointerdown', 100, 150, 1))
cropBox().dispatchEvent(pev('pointerdown', 200, 150, 2))
cropBox().dispatchEvent(pev('pointermove', 50, 150, 1))
await tick(20)
v = readView()
const k = 1 - 1.5
ok(near(v.s, v0.s * 1.5), '捏合放大 1.5 倍')
ok(
  near(v.cx, v0.cx - 25 + k * (150 - v0.cx)) && near(v.cy, v0.cy + k * (150 - v0.cy)),
  '捏合平移符合中点公式',
)
cropBox().dispatchEvent(pev('pointerup', 50, 150, 1))
cropBox().dispatchEvent(pev('pointerup', 200, 150, 2))
await tick(20)

console.log('\n场景 F2：捏合到最大后点「复位」→ 旋转与取景全部归零')
findBtn('复位').click()
await tick(30)
v = readView()
ok(v.rot === 0, '复位后旋转归零')
ok(near(v.s, 288 / 800), '复位后缩放回到整图可见(0.36)')
ok(near(v.cx, 144) && near(v.cy, 144), '复位后取景居中')

console.log('\n场景 G：完成裁剪 → 9 参 drawImage 导出（源矩形由预览取景反推，无变换栈）→ 上传并清理旧头像')
v = readView()
const imgEl = cropImg()
ctxCalls.length = 0
findBtn('完成').click()
await tick(120)
ok(!bodyText().includes('裁剪头像'), '裁剪弹窗关闭')
const previewImg = [...document.querySelectorAll('img')].find((i) => i.alt === '预览')
ok(!!previewImg && previewImg.src.startsWith('blob:fake-'), '编辑弹窗出现裁剪后预览')
ok(ctxCalls[0]?.[0] === 'fillRect' && ctxCalls[0][1] === 0 && ctxCalls[0][3] === 512, '先铺白底 512×512')
// 从预览取景独立推算源矩形（rot=0）：d=216、o=36，q=(p−c)/s，u=q+半宽
const sw = 216 / v.s
const sxExp = (36 - v.cx) / v.s + 400
const syExp = (36 - v.cy) / v.s + 300
ok(ctxCalls[1]?.[0] === 'drawImage' && ctxCalls[1][1] === imgEl, '直接 drawImage 原图（无 scale/translate/rotate 叠加）')
ok(
  near(ctxCalls[1][2], sxExp) && near(ctxCalls[1][3], syExp) && near(ctxCalls[1][4], sw) && near(ctxCalls[1][5], sw),
  `源矩形=圆区反推 sx=${sxExp.toFixed(1)} sy=${syExp.toFixed(1)} sw=${sw.toFixed(1)}`,
)
ok(ctxCalls[1][6] === 0 && ctxCalls[1][7] === 0 && ctxCalls[1][8] === 512 && ctxCalls[1][9] === 512, '目标区铺满 512×512')
findBtn('保存').click()
await tick(250)
ok(uploaded.length === 1 && uploaded[0].endsWith('.jpg'), '裁剪结果以 .jpg 上传')
ok(lastUpdate?.payload?.avatar_path === uploaded[0], 'members.avatar_path 指向新文件')
ok(removed.includes('old-avatar.jpg'), '旧头像文件已清理')
ok(membersDb[0].avatar_path === uploaded[0], '数据库行已更新')

console.log('\n场景 H：取消裁剪不影响已有头像预览；竖图初始化正确')
pickImage('photo2')
await waitFor(() => bodyText().includes('裁剪头像'), '再次打开裁剪器')
await waitFor(() => cropImg(), '第二次预览 img 出现')
loadImage(400, 800)
await waitFor(() => readView(), '竖图取景初始化')
v = readView()
ok(near(v.s, 288 / 800), '竖图初始整图可见(0.36)，圆直径=288×0.5 不再放大')
findBtn('取消').click()
await tick(40)
ok(!bodyText().includes('裁剪头像'), '取消后裁剪弹窗关闭')
ok(!![...document.querySelectorAll('img')].find((i) => i.alt === '预览'), '上一张裁剪预览仍在')

root.unmount()
await tick(30)

console.log(`\n========== 结果：${pass} 通过 / ${failures.length} 失败 ==========`)
if (failures.length) {
  console.log('失败项：')
  failures.forEach((f) => console.log(' -', f))
  process.exit(1)
}
