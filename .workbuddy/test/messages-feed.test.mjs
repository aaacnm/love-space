/**
 * 留言板「混合时间流」测试
 *   1. 时间流渲染：留言本体（文字/语音/图片/回复引用条）按时间倒序；评论不进主流，
 *      收进「留言详情」弹窗（点 💬 打开：原文 + 评论列表 + 可发评论）
 *   2. 隐藏语义：被隐藏的留言不进流，挂在它下面的评论一并隐藏，已隐藏区可见
 *   3. 表情回应：😊+ 弹 emoji 排 → insert；再点自己的 chip → delete；我的高亮
 *   4. 发送：文字/图片/语音 insert 均不带 reply_to（回复功能已并入评论，卡上无「↩ 回复」按钮）；
 *      图片 → upload 到 photos bucket 的 messages/ 前缀 + insert image_path（compressImage 失败安全回退原图）
 *   5. push-send 文案：图片留言单独分支（源码扫描）
 *   6. 语音全流程（stub voice.js）：回复状态下发语音带 reply_to、成功才关弹窗；
 *      上传失败弹窗保持打开、错误可见、恢复后可直接重试
 *
 * 用法：NODE_PATH=<workspace>/node_modules node messages-feed.test.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------- jsdom 环境 ----------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true })
global.HTMLElement = dom.window.HTMLElement
global.Node = dom.window.Node
global.Event = dom.window.Event
global.CustomEvent = dom.window.CustomEvent
global.getComputedStyle = dom.window.getComputedStyle
global.localStorage = dom.window.localStorage
global.requestAnimationFrame = (cb) => setTimeout(cb, 0)
global.cancelAnimationFrame = (id) => clearTimeout(id)
// compressImage 的解码链路在 jsdom 里必然失败（无 canvas 位图），要保证安全回退不崩
global.URL.createObjectURL = () => 'blob:stub'
global.URL.revokeObjectURL = () => {}
globalThis.createImageBitmap = async () => {
  throw new Error('jsdom 无位图解码')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tick = (ms = 10) => sleep(ms)

let pass = 0
const fails = []
const ok = (cond, msg) => {
  if (cond) pass++
  else fails.push(msg)
}

// ---------- 数据 / stub ----------
const T = (agoMs) => new Date(Date.now() - agoMs).toISOString()
const MEMBERS = [
  { user_id: 'u1', nickname: '我', gender: 'female' },
  { user_id: 'u2', nickname: '宝贝', gender: 'male' },
]

const msgsDb = [
  { id: 'm1', couple_id: 'c1', author_user_id: 'u2', content: '今天也想你', created_at: T(4000) },
  { id: 'm2', couple_id: 'c1', author_user_id: 'u1', content: '', voice_path: 'c1/v1.m4a', voice_seconds: 8, created_at: T(3000) },
  { id: 'm3', couple_id: 'c1', author_user_id: 'u2', content: '', image_path: 'messages/c1/img1.jpg', created_at: T(2000) },
  { id: 'm4', couple_id: 'c1', author_user_id: 'u2', content: '回复测试正文', reply_to: 'm1', created_at: T(1000) },
  { id: 'm5', couple_id: 'c1', author_user_id: 'u2', content: '被隐藏的留言', created_at: T(2500) },
]
const hiddenDb = [{ id: 'h1', couple_id: 'c1', message_id: 'm5', user_id: 'u1', permanent: false, purged_at: null, created_at: T(0) }]
const commentsDb = [
  { id: 'cm1', couple_id: 'c1', message_id: 'm1', author_user_id: 'u1', content: '我也想你呀', created_at: T(1500) },
  { id: 'cm2', couple_id: 'c1', message_id: 'm5', author_user_id: 'u1', content: '评论了被隐藏留言', created_at: T(1200) },
]
const reactionsDb = [
  { id: 'r1', couple_id: 'c1', message_id: 'm1', user_id: 'u2', emoji: '💗', created_at: T(500) },
  { id: 'r2', couple_id: 'c1', message_id: 'm1', user_id: 'u1', emoji: '💗', created_at: T(400) },
]

function seed() {
  globalThis.__COLLECTIONS__ = {
    messages: structuredClone(msgsDb),
    message_hidden: structuredClone(hiddenDb),
    message_comments: structuredClone(commentsDb),
    message_reactions: structuredClone(reactionsDb),
  }
}

let inserted = []
let deletedRows = []
let uploadLog = []
let signLog = [] // 记录签名调用（路径 + transform），锁死灯箱 contain 变换
let alerts = []

const __SUPA__ = {
  from: (t) => {
    const q = {}
    q.insert = (p) => {
      q._ins = Array.isArray(p) ? p : [p]
      return q
    }
    q.delete = () => q
    q.eq = (c, v) => {
      ;(q._eq ||= []).push([c, v])
      return q
    }
    q.then = (res, rej) => run().then(res, rej)
    async function run() {
      if (q._ins) {
        for (const row of q._ins) inserted.push({ table: t, row })
        return { data: null, error: null }
      }
      if (q._eq && q._eq.length) {
        // message_reactions 按 id 删除
        const [c, v] = q._eq[0]
        const idx = reactionsDb.findIndex((r) => r[c] === v)
        if (idx >= 0) deletedRows.push({ table: t, row: reactionsDb[idx] })
        return { data: null, error: null }
      }
      return { data: null, error: null }
    }
    return q
  },
  storage: {
    from: () => ({
      getPublicUrl: (p) => ({ data: { publicUrl: 'http://x/object/public/' + p } }),
      createSignedUrl: async (p, _t, opts) => {
        signLog.push({ path: p, transform: (opts && opts.transform) || null })
        return { data: { signedUrl: 'http://x/sign/' + p } }
      },
      createSignedUrls: async (paths) => {
        paths.forEach((p) => signLog.push({ path: p, transform: null, batch: true }))
        return { data: paths.map((p) => ({ path: p, signedUrl: 'http://x/sign/' + p })), error: null }
      },
      upload: async (p, file, opts) => {
        if (globalThis.__UPLOAD_FAIL__) return { error: { message: '网络开小差了' } }
        uploadLog.push({ path: p, type: opts && opts.contentType, size: file.size })
        return { error: null }
      },
      remove: async () => ({ error: null }),
    }),
  },
}

const hooksStub = `
export function useCollection(table, _coupleId, _opts) {
  return {
    rows: globalThis.__COLLECTIONS__[table] || [],
    loading: false,
    reload: () => { globalThis.__RELOADS__ = (globalThis.__RELOADS__ || 0) + 1 },
  }
}
// 分页版：测试数据量小，直接全量返回（hasMore=false，LoadMore 不触发）
export function usePagedCollection(table, _coupleId, _opts) {
  return {
    rows: globalThis.__COLLECTIONS__[table] || [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    reload: () => { globalThis.__RELOADS__ = (globalThis.__RELOADS__ || 0) + 1 },
    loadMore: () => {},
  }
}
export const NOTE_COLORS = [{ bg: '#fdf6e3', border: '#eee0c9' }]
export function formatDateTime(iso) { return new Date(iso).toISOString() }
export function todayStr() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
`
const supaStub = `export const supabase = globalThis.__SUPA__`
const storeStub = `
export function StoreProvider({ children }) { return children }
export function useStore() { return globalThis.__STORE__ }
`
// voice.js stub：录音引擎直接给一条 5 秒 WAV（不真录），decodeVoice/getAudioCtx 保持无害
const voiceStub = `
export function recorderSupported() { return true }
export async function startRecording() {
  return {
    mime: 'audio/wav',
    ext: 'wav',
    stop: async () => ({ blob: new Blob(['RIFF'], { type: 'audio/wav' }), seconds: 5 }),
    cancel: () => {},
  }
}
export async function cancelRecording() {}
export async function decodeVoice() { throw new Error('jsdom 无音频解码') }
export function getAudioCtx() { return null }
`

const plugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /supabase\.js$/ }, () => ({ path: 'supa-stub', namespace: 'stub' }))
    b.onResolve({ filter: /hooks\.js$/ }, () => ({ path: 'hooks-stub', namespace: 'stub' }))
    b.onResolve({ filter: /store\.jsx$/ }, () => ({ path: 'store-stub', namespace: 'stub' }))
    b.onResolve({ filter: /voice\.js$/ }, () => ({ path: 'voice-stub', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents:
        args.path === 'supa-stub'
          ? supaStub
          : args.path === 'hooks-stub'
            ? hooksStub
            : args.path === 'store-stub'
              ? storeStub
              : voiceStub,
      loader: 'js',
    }))
  },
}

// ---------- 打包 ----------
const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'messages-feed.bundle.cjs')
await esbuild.build({
  entryPoints: ['D:/love/src/views/Messages.jsx'],
  bundle: true,
  format: 'cjs',
  jsx: 'automatic',
  platform: 'node',
  packages: 'external',
  define: { 'import.meta.env': '{}' },
  plugins: [plugin],
  outfile: out,
})

globalThis.__SUPA__ = __SUPA__
globalThis.__STORE__ = { coupleId: 'c1', user: { id: 'u1' }, members: MEMBERS }

const ReactDomClient = require('react-dom/client')
const ReactCore = require('react')
const Messages = require(out).default

const bodyText = () => document.body.textContent || ''
const findBtns = (txt) => [...document.querySelectorAll('button')].filter((b) => b.textContent.includes(txt))
const clickByText = (txt, scope = document) => {
  const btn = [...scope.querySelectorAll('button')].filter((b) => b.textContent.includes(txt))
  if (btn.length) {
    btn[btn.length - 1].click()
    return true
  }
  return false
}

let root = null
async function mount() {
  if (root) {
    root.unmount()
    await tick(30)
  }
  seed()
  inserted = []
  deletedRows = []
  uploadLog = []
  signLog = []
  alerts = []
  window.alert = (m) => alerts.push(String(m))
  const container = document.getElementById('root')
  container.innerHTML = ''
  root = ReactDomClient.createRoot(container)
  root.render(ReactCore.createElement(Messages))
  await tick(80)
}

// ============================================================
console.log('\n场景 1：时间流渲染（文字/语音/图片/回复引用）；评论收进详情不进主流')

await mount()
{
  // 顺序断言（新的在上）：m4 回复 → m3 图片 → m2 语音 → m1 原留言
  ok(
    bodyText().indexOf('回复测试正文') < bodyText().lastIndexOf('今天也想你'),
    '时间流排序：m4 回复 → … → m1 原留言',
  )

  ok(bodyText().includes('↩ 回复 宝贝：今天也想你'), '历史回复消息的引用条仍展示（只读兼容）')
  ok(findBtns('↩ 回复').length === 0, '「↩ 回复」按钮已移除（回应统一走评论）')
  ok(!bodyText().includes('评论 宝贝 的留言'), '评论条不再混入主流（收进详情弹窗）')
  ok(!bodyText().includes('我也想你呀'), '评论内容不出现在主流')

  // 评论数仍可见：m1 有 cm1 一条评论 → 💬 1
  ok(findBtns('💬 1').length >= 1, '卡上 💬 按钮显示评论数')

  const imgs = [...document.querySelectorAll('img[alt="图片留言"]')]
  ok(imgs.length >= 1 && imgs[0].src.includes('/sign/'), '图片留言走私有桶签名 URL')
  ok(
    signLog.some((r) => (r.path || '').includes('messages/c1/img1') && r.transform === null),
    '流内缩略图批量签真实文件（无 transform，裁切交给 CSS object-cover）',
  )

  // 语音消息有 VoiceNote 按钮（播放键）
  ok(findBtns('▶').length >= 1, '语音留言渲染出播放按钮')

  // 灯箱：点图片 → 大图按需单签 + contain 变换 → 关闭
  imgs[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await tick(50)
  // 取最后一个 fixed 弹窗（.backdrop-blur-sm 在主页也有同名元素，不能当定位器）
  const modalList = [...document.querySelectorAll('div.fixed.inset-0')]
  const lb = modalList[modalList.length - 1]
  ok(!!lb && lb.textContent.includes('图片留言'), '点图片打开灯箱弹窗')
  ok(
    signLog.some((r) => (r.path || '').includes('messages/c1/img1') && r.transform && r.transform.resize === 'contain' && r.transform.height === 1280),
    '灯箱大图按需单签（transform: height=1280 contain）',
  )
  const lbMask = lb.querySelector('.backdrop-blur-sm') || lb
  lbMask.click()
  await tick(40)
  ok(!bodyText().includes('🖼️ 图片留言'), '关闭灯箱还干净环境')

  // 反应 chip：m1 有 u1+u2 两个 💗 → 计数 2，我的高亮
  const chip = findBtns('💗 2')[0]
  ok(!!chip, '反应 chip 显示 💗 2')
  ok(chip && chip.className.includes('text-rosy'), '我也点过的 chip 高亮')

  // 隐藏语义
  ok(!bodyText().includes('被隐藏的留言'), '被隐藏的留言不进主流')
  ok(bodyText().includes('已隐藏 1 条'), '已隐藏区入口显示条数')
}

// React 受控 input 的 value tracker：直接赋值会被 React 忽略，必须用原生 setter
function setInputValue(input, v) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, v)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

// ============================================================
console.log('\n场景 2：表情回应 —— 😊+ 弹排 → insert；再点自己的 chip → delete')

{
  // m3（图片留言）没有反应 → 定位到它的卡片，点卡内的 😊+ 出 emoji 排
  const img3 = document.querySelector('img[alt="图片留言"]')
  ok(!!img3, '图片留言卡存在')
  const card3 = img3.closest('.note')
  const plus3 = [...card3.querySelectorAll('button')].find((b) => b.textContent.includes('😊+'))
  plus3.click()
  await tick(30)
  const pad3 = [...card3.querySelectorAll('button')].find((b) => b.textContent.trim() === '💗')
  ok(!!pad3, '点 😊+ 后该卡内弹出 emoji 选择排')
  pad3.click()
  await tick(40)
  const ins = inserted.filter((x) => x.table === 'message_reactions')
  ok(
    ins.length === 1 && ins[0].row.message_id === 'm3' && ins[0].row.emoji === '💗' && ins[0].row.user_id === 'u1',
    '点 💗 → insert {message_id, user_id, emoji}',
  )
  ok((globalThis.__RELOADS__ || 0) >= 1, 'insert 后刷新回应列表')
  ok(
    ![...card3.querySelectorAll('button')].some((b) => b.textContent.trim() === '💗'),
    '选择后 emoji 排收起',
  )

  // m1 的 💗 2 chip（我已点过 r2）→ 再点 = 取消 → delete by id
  globalThis.__RELOADS__ = 0
  clickByText('💗 2')
  await tick(40)
  ok(deletedRows.length === 1 && deletedRows[0].row.id === 'r2', '再点自己的 chip → delete 我那行（r2）')
  ok((globalThis.__RELOADS__ || 0) >= 1, 'delete 后刷新回应列表')
}

// ============================================================
console.log('\n场景 2.5：留言详情弹窗 —— 评论收进详情，可查看可新发')

{
  await mount()
  ok(clickByText('💬 1'), '点开 m1 卡上的 💬 1')
  await tick(30)
  ok(bodyText().includes('留言详情'), '详情弹窗打开')
  ok(bodyText().includes('今天也想你'), '详情里显示留言原文')
  ok(bodyText().includes('我也想你呀'), '评论列表在详情里可见')

  // 在详情里发一条评论
  const ta = document.querySelector('textarea')
  ok(!!ta, '评论输入框存在')
  const taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  taSetter.call(ta, '详情里发的新评论')
  ta.dispatchEvent(new window.Event('input', { bubbles: true }))
  await tick(20)
  clickByText('发送')
  await tick(40)
  const cins = inserted.filter((x) => x.table === 'message_comments')
  ok(
    cins.length === 1 && cins[0].row.content === '详情里发的新评论' && cins[0].row.message_id === 'm1',
    '详情内发评论 → insert message_comments（挂在 m1 下）',
  )

  // 关闭弹窗（点遮罩），还干净环境给下一个场景
  const mask = document.querySelector('.backdrop-blur-sm')
  ok(!!mask, '弹窗遮罩存在')
  mask.click()
  await tick(30)
  ok(!bodyText().includes('留言详情'), '关闭详情弹窗')
}

// ============================================================
console.log('\n场景 3：发送文字 / 回复 / 图片')

{
  await mount()
  // 3a. 文字
  const input = document.querySelector('input[placeholder="给 TA 留句话…"]')
  ok(!!input, '输入栏存在')
  setInputValue(input, '新留言测试')
  await tick(20)
  clickByText('发送')
  await tick(40)
  const msgIns = inserted.filter((x) => x.table === 'messages')
  ok(msgIns.length === 1 && msgIns[0].row.content === '新留言测试' && !msgIns[0].row.reply_to, '文字发送：insert content，无 reply_to')

  // 3b. 回复功能已并入评论：卡上没有「↩ 回复」按钮
  ok(findBtns('↩ 回复').length === 0, '卡上无回复按钮，回应统一走 💬 评论')

  // 3c. 图片：file input → compressImage 回退原图 → upload photos bucket messages/ 前缀 → insert image_path
  const fileInput = document.querySelector('input[type="file"]')
  ok(!!fileInput, '图片入口（隐藏 file input）存在')
  const f = new window.File([new Blob(['jpeg-bytes'], { type: 'image/jpeg' })], 'pic.jpg', { type: 'image/jpeg' })
  Object.defineProperty(fileInput, 'files', { value: [f], configurable: true })
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }))
  await tick(300) // compressImage 异步链（jsdom 里快速失败回退）+ upload + insert
  ok(uploadLog.length === 1 && uploadLog[0].path.startsWith('messages/c1/'), `图片上传到 photos bucket messages/ 前缀（${uploadLog[0] && uploadLog[0].path}）`)
  const imgIns = inserted.filter((x) => x.table === 'messages').pop()
  ok(imgIns && imgIns.row.image_path === uploadLog[0].path && imgIns.row.content === '', 'insert 带 image_path，且与上传路径一致')
  ok(alerts.length === 0, `图片发送全链路无报错（alerts=${JSON.stringify(alerts)}）`)
}

// ============================================================
console.log('\n场景 4：push-send 文案（源码扫描）')

{
  const ts = fs.readFileSync('D:/love/supabase/functions/push-send/index.ts', 'utf8')
  ok(/image_path[^}]*?给你发来一张图片留言/.test(ts), '图片留言推送文案分支存在')
  ok(/reply_to[^}]*?回复了你的留言/.test(ts), '回复留言推送文案分支存在')
  ok(ts.includes('message_comments'), '评论推送保留')

  // 前台横幅与推送文案保持一致（Notifier.jsx 也要有四分支）
  const notifier = fs.readFileSync('D:/love/src/components/Notifier.jsx', 'utf8')
  ok(
    notifier.includes('给你发来一张图片留言') &&
      notifier.includes('回复了你的留言') &&
      notifier.includes('给你发来一条语音留言'),
    '前台横幅文案四分支与 push-send 对齐',
  )
}

// ============================================================
console.log('\n场景 5：语音发送成功 —— 弹窗关闭，消息不带 reply_to')

{
  // 独立 mount：清空场景 3 遗留的上传/插入记录，从干净状态验证语音链路
  await mount()
  findBtns('🎙️')[0].click()
  await tick(30)
  const beginBtn = document.querySelector('button[aria-label="开始录音"]')
  ok(!!beginBtn, '录音弹窗打开（idle 态）')
  beginBtn.click()
  await tick(60)
  clickByText('✔ 录好了')
  await tick(60)
  ok(bodyText().includes('试听一下'), '录完进入试听界面')
  clickByText('发出去')
  await tick(80)
  ok(!bodyText().includes('试听一下'), '发送成功后弹窗自动关闭')
  ok(
    uploadLog.length === 1 && uploadLog[0].path.startsWith('c1/') && uploadLog[0].path.endsWith('.wav'),
    `语音上传到 voice bucket（${uploadLog[0] && uploadLog[0].path}）`,
  )
  const voiceIns = inserted.filter((x) => x.table === 'messages').pop()
  ok(
    voiceIns && voiceIns.row.voice_path === uploadLog[0].path && voiceIns.row.voice_seconds === 5,
    'insert 带 voice_path + voice_seconds',
  )
  ok(voiceIns && !voiceIns.row.reply_to, '语音消息不带 reply_to（回复功能已并入评论）')
}

// ============================================================
console.log('\n场景 6：语音发送失败 —— 弹窗保持打开、错误可见、可直接重试')

{
  await mount()
  globalThis.__UPLOAD_FAIL__ = true
  findBtns('🎙️')[0].click()
  await tick(30)
  document.querySelector('button[aria-label="开始录音"]').click()
  await tick(60)
  clickByText('✔ 录好了')
  await tick(60)
  ok(bodyText().includes('试听一下'), '进入试听界面')
  clickByText('发出去')
  await tick(80)
  ok(bodyText().includes('试听一下'), '发送失败后弹窗仍打开（不再静默关闭）')
  ok(bodyText().includes('语音上传失败'), '失败原因显示在弹窗内')
  ok(inserted.filter((x) => x.table === 'messages').length === 0, '上传失败时不写数据库')
  ok(alerts.length === 0, '无需 window.alert（错误在弹窗内展示）')

  // 网络恢复 → 再点「发出去」→ 成功入库 + 弹窗关闭
  globalThis.__UPLOAD_FAIL__ = false
  clickByText('发出去')
  await tick(80)
  ok(!bodyText().includes('试听一下'), '重试成功后弹窗关闭')
  const voiceIns = inserted.filter((x) => x.table === 'messages').pop()
  ok(voiceIns && voiceIns.row.voice_path && voiceIns.row.voice_seconds === 5, '重试成功：语音消息入库')
}

// ---------- 结果 ----------
console.log(`\n结果：${pass} 通过${fails.length ? `，${fails.length} 失败` : '，0 失败'}`)
for (const f of fails) console.log('  ✗ ' + f)
if (root) {
  root.unmount()
  await tick(20)
}
process.exit(fails.length ? 1 : 0)
