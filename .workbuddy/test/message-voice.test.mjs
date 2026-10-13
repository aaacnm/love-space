// 语音留言修复的冒烟测试
//   1. WAV 主路（WebAudio PCM 直录）：首包门闩、引擎级联（SP→Worklet→MediaRecorder）、
//      挂起 ctx 复活（「录多久都太短」的根因场景）、WAV 编码正确性
//   2. 录音弹窗：处理中反馈、启动中状态、引擎降级后照常可用、空数据提示
//   3. 彻底删除：update 命中（RLS 放行）→ 正常打 purged_at；update 被静默过滤（data 空）→ 明确提示跑迁移
//   4. VoiceNote 双引擎播放：media 失败(play 拒绝/播放中 error)自动降级 WebAudio 断点续播，
//      decode 也失败才显示「播放失败」，失败态点按走 WebAudio 重试
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// ---------- jsdom ----------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const { window } = dom
for (const k of ['window', 'document', 'localStorage', 'CustomEvent', 'Event', 'Node', 'HTMLElement', 'location', 'getComputedStyle', 'MutationObserver', 'URL', 'File', 'Blob']) {
  if (window[k] !== undefined) globalThis[k] = window[k]
}
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.HTMLInputElement = window.HTMLInputElement
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0)

let urlSeq = 0
window.URL.createObjectURL = () => 'blob:fake-' + ++urlSeq
window.URL.revokeObjectURL = () => {}

// 统一提示（Toast 取代 alert）：组件不挂 Provider 时 toast 模块会兜底渲染到 body
const toastTexts = () => [...document.querySelectorAll('[data-toast-item]')].map((el) => el.textContent || '')
const clearToasts = () => globalThis.__TOAST__ && globalThis.__TOAST__.clear()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tick = (ms = 30) => sleep(ms)

// ---------- Fake MediaRecorder ----------
// 模拟真实浏览器行为：stop() 后先派发最后一个 dataavailable（全量），再派发 stop
let fireStop = true // stop() 后是否派发 stop 事件（false = 模拟 iOS 挂起）
let lateDataMs = 0 // dataavailable 延迟毫秒（模拟 iOS 迟到 flush）
let sendData = true // false = 模拟「数据永远不来」（极端 iOS）
const recorderLog = []
class FakeRecorder extends window.EventTarget {
  constructor(stream, opts = {}) {
    super()
    this.stream = stream
    this.mimeType = opts.mimeType || 'audio/mp4'
    this.mimeArg = opts.mimeType
    this.state = 'recording'
    recorderLog.push(this)
  }
  static isTypeSupported() {
    return true
  }
  start() {
    // 真实实现改为 start() 不带 timeslice（iOS 定时切片常不触发），无切片定时器
  }
  stop() {
    if (this.state === 'inactive') throw new Error('InvalidState: inactive')
    this.state = 'inactive'
    setTimeout(() => {
      if (sendData) {
        this.dispatchEvent(
          Object.assign(new window.Event('dataavailable'), {
            data: new window.Blob(['chunkdata'], { type: this.mimeType }),
          }),
        )
      }
    }, lateDataMs)
    if (fireStop) {
      setTimeout(() => this.dispatchEvent(new window.Event('stop')), lateDataMs + 15)
    }
  }
}
globalThis.MediaRecorder = FakeRecorder
window.MediaRecorder = FakeRecorder

// getUserMedia / mediaDevices
const trackStopLog = []
const liveStream = { getTracks: () => [{ stop: () => trackStopLog.push(1) }] }
Object.defineProperty(window.navigator, 'mediaDevices', {
  value: { getUserMedia: async () => liveStream },
  configurable: true,
})
Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  value: { getUserMedia: async () => liveStream },
  configurable: true,
})

// ---------- Fake AudioContext（WAV 主路 stub） ----------
// 不挂 stub 时 voice.js 自动降级 MediaRecorder 兜底——两组场景都覆盖
const procLog = [] // createScriptProcessor 产物，onaudioprocess 手动喂数据
const wlLog = [] // AudioWorkletNode 产物
let autoFeedSp = true // SP 创建后 10ms 自动吐第一帧（配合 voice.js 的首包门闩）
let autoFeedWl = true // worklet 创建后 10ms 自动吐第一条消息
const frameEvt = () => ({ inputBuffer: { getChannelData: () => new Float32Array(128).fill(0.5) } })
class FakeAudioContext {
  constructor() {
    this.sampleRate = 48000
    this.currentTime = 0
    this.destination = {}
    this.state = 'running'
    this.resume = async () => {}
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} }
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} }
  }
  createBuffer(ch, len, rate) {
    const data = new Float32Array(len)
    return { length: len, sampleRate: rate, getChannelData: () => data }
  }
  createBufferSource() {
    return { buffer: null, connect() {}, start() {}, disconnect() {} }
  }
  createScriptProcessor(size) {
    const sp = { bufferSize: size, onaudioprocess: null, connect() {}, disconnect() {} }
    procLog.push(sp)
    if (autoFeedSp) setTimeout(() => sp.onaudioprocess && sp.onaudioprocess(frameEvt()), 10)
    return sp
  }
}
class FakeWorkletNode {
  constructor(_ctx, _name) {
    this.port = { onmessage: null }
    wlLog.push(this)
    if (autoFeedWl)
      setTimeout(() => this.port.onmessage && this.port.onmessage({ data: new Float32Array(128).fill(0.5) }), 10)
  }
  connect() {}
  disconnect() {}
}
class FakeCtxWithWorklet extends FakeAudioContext {
  constructor() {
    super()
    this.audioWorklet = { addModule: async () => {} }
  }
}
// 「永远太短」根因复现：ctx 初始挂起，resume 后才真正出数据（真实 iOS 的行为）
class FakeCtxSuspend extends FakeAudioContext {
  constructor() {
    super()
    this.state = 'suspended'
    this._fed = false
  }
  resume() {
    this.state = 'running'
    if (!this._fed) {
      this._fed = true
      setTimeout(() => {
        const sp = procLog[procLog.length - 1]
        sp && sp.onaudioprocess && sp.onaudioprocess(frameEvt())
      }, 50)
    }
    return Promise.resolve()
  }
}
class FakeOfflineAudioContext {
  constructor(ch, length, rate) {
    this._length = length
    this._rate = rate
    this.destination = {}
  }
  createBuffer(ch, len, rate) {
    const data = new Float32Array(len)
    return {
      length: len,
      sampleRate: rate,
      getChannelData: () => data,
      copyToChannel: (arr) => data.set(arr),
    }
  }
  createBufferSource() {
    return { connect() {}, start() {} }
  }
  startRendering() {
    const out = new Float32Array(this._length).fill(0.5)
    // 100ms 延迟模拟真实编码耗时（真机 OfflineAudioContext 渲染要几百 ms，「处理中」反馈才可见）
    return new Promise((res) => setTimeout(() => res({ length: this._length, sampleRate: this._rate, getChannelData: () => out }), 100))
  }
}
const attachAudioStub = () => {
  window.AudioContext = FakeAudioContext
  globalThis.AudioContext = FakeAudioContext
  window.OfflineAudioContext = FakeOfflineAudioContext
  globalThis.OfflineAudioContext = FakeOfflineAudioContext
}
const detachAudioStub = () => {
  delete window.AudioContext
  delete globalThis.AudioContext
  delete window.OfflineAudioContext
  delete globalThis.OfflineAudioContext
}
const feedPcm = (frames, val = 0.5) => {
  const sp = procLog[procLog.length - 1]
  for (let f = 0; f < frames; f++) {
    sp.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(128).fill(val) } })
  }
}
const feedWl = (frames, val = 0.5) => {
  const node = wlLog[wlLog.length - 1]
  for (let f = 0; f < frames; f++) {
    node.port.onmessage({ data: new Float32Array(128).fill(val) })
  }
}
const blobView = (blob) =>
  new Promise((res, rej) => {
    const fr = new window.FileReader()
    fr.onload = () => res(new DataView(fr.result))
    fr.onerror = rej
    fr.readAsArrayBuffer(blob)
  })
const wavStr = (dv, off, len) => {
  let s = ''
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i))
  return s
}

// ---------- esbuild 打包 ----------
const here = path.dirname(fileURLToPath(import.meta.url))
const React = require('react')
const ReactDOM = require('react-dom/client')

// 返回整个 cjs 模块 exports（esbuild 打包的 ESM 源码：命名导出在顶层，default 组件用 .default 取）
async function bundle(entry, outfile, extraPlugins = []) {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    jsx: 'automatic',
    platform: 'node',
    packages: 'external',
    outfile,
    plugins: extraPlugins,
    logLevel: 'silent',
  })
  return require(outfile)
}

function mount(Component, props) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOM.createRoot(host)
  root.render(React.createElement(Component, props))
  return {
    async unmount() {
      root.unmount()
      host.remove()
      await tick(20)
    },
  }
}
const bodyText = () => document.body.textContent
const findBtn = (text) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent.includes(text) || (b.getAttribute('aria-label') || '').includes(text),
  )

// ============================================================
console.log('\n场景组 1：WAV 主路（WebAudio PCM 直录）')

{
  attachAudioStub()
  const voice = await bundle('D:/love/src/lib/voice.js', path.join(here, 'voice-wav.bundle.cjs'))

  // 1a. 接口与引擎选择（首包门闩：startRecording 返回时 PCM 已确认在流动）
  const rec = await voice.startRecording()
  autoFeedSp = false // 门闩已过，后续场景手动喂数
  ok(rec.mime === 'audio/wav' && rec.ext === 'wav', 'WAV 主路：mime=audio/wav ext=wav')
  ok(procLog.length === 1, '创建 ScriptProcessor 收集 PCM')
  ok(recorderLog.length === 0, 'PCM 引擎正常时不惊动 MediaRecorder 兜底')

  // 1b. 喂 1.2s@48kHz（门闩自动 1 帧 + 手动 449 帧 = 450 帧 × 128 = 57600）→ stop → 16k WAV
  feedPcm(449)
  const r = await rec.stop()
  ok(r.seconds === 1, `秒数来自样本数/采样率（${r.seconds}s）`)
  const dv = await blobView(r.blob)
  ok(wavStr(dv, 0, 4) === 'RIFF' && wavStr(dv, 8, 4) === 'WAVE', 'WAV 头：RIFF/WAVE')
  ok(wavStr(dv, 12, 4) === 'fmt ' && wavStr(dv, 36, 4) === 'data', 'WAV 头：fmt/data 块')
  ok(dv.getUint16(22, true) === 1 && dv.getUint16(34, true) === 16, '单声道 16bit')
  ok(dv.getUint32(24, true) === 16000, `重采样到 16kHz（实际 ${dv.getUint32(24, true)}）`)
  ok(r.blob.size === 44 + 19200 * 2, `文件大小 = 44 头 + 16k×1.2s×2B（${r.blob.size}）`)
  ok(Math.abs(dv.getInt16(44, true) - 16383) <= 1, `0.5 振幅编码为 int16≈16383（实际 ${dv.getInt16(44, true)}）`)

  // 1c. 「永远太短」根治：SP 一个字节都不吐（iOS 挂起态救不活）→ 自动降级 MediaRecorder
  const before = recorderLog.length
  const t1c = Date.now()
  const rec2 = await voice.startRecording()
  autoFeedSp = false
  ok(recorderLog.length === before + 1 && rec2.ext === 'm4a', `PCM 通道哑火自动降级 MediaRecorder（耗时 ${Date.now() - t1c}ms）`)
  const r2 = await rec2.stop()
  ok(r2.blob.size > 0, '降级引擎正常出数据')
  autoFeedSp = true

  // 1c-2. 降级也不可用（无 MediaRecorder）→ 明确报错而非假成功
  const MRSave = globalThis.MediaRecorder
  delete globalThis.MediaRecorder
  delete window.MediaRecorder
  autoFeedSp = false // PCM 也保持哑火，才会走「全哑火」分支
  let dead = ''
  try {
    await voice.startRecording()
  } catch (e) {
    dead = e.message
  }
  ok(dead.includes('麦克风'), `全哑火时明确报错（${dead}）`)
  globalThis.MediaRecorder = MRSave
  window.MediaRecorder = MRSave
  autoFeedSp = true

  // 1d. OfflineAudioContext 不可用 → 按原始采样率直编（音质不变，文件大些）
  delete window.OfflineAudioContext
  delete globalThis.OfflineAudioContext
  const rec3 = await voice.startRecording()
  autoFeedSp = false
  feedPcm(449)
  const r3 = await rec3.stop()
  const dv3 = await blobView(r3.blob)
  ok(dv3.getUint32(24, true) === 48000, '无 Offline 时按 48kHz 直编')
  ok(r3.blob.size === 44 + 57600 * 2, '48kHz 直编文件大小正确')
  attachAudioStub()
  autoFeedSp = true

  // 1e. cancel：停轨道清理
  trackStopLog.length = 0
  const rec4 = await voice.startRecording()
  autoFeedSp = false
  await rec4.cancel()
  ok(trackStopLog.length >= 1, 'cancel 停掉麦克风轨道')
  autoFeedSp = true

  // 1f. 权限拒绝 → 友好文案
  const gUM = window.navigator.mediaDevices.getUserMedia
  Object.defineProperty(window.navigator.mediaDevices, 'getUserMedia', {
    value: async () => {
      const err = new Error('denied')
      err.name = 'NotAllowedError'
      throw err
    },
    configurable: true,
  })
  let denied = ''
  try {
    await voice.startRecording()
  } catch (e) {
    denied = e.message
  }
  ok(denied.includes('权限被拒绝'), `权限拒绝给友好提示（${denied}）`)
  Object.defineProperty(window.navigator.mediaDevices, 'getUserMedia', {
    value: gUM,
    configurable: true,
  })
  detachAudioStub()

  // 1g. SP 哑火但 AudioWorklet 活着 → 自动换 worklet 采集（换新 bundle = 换新 sharedCtx）
  {
    attachAudioStub() // 先恢复完整 stub（含 OfflineAudioContext），再只换 AudioContext
    autoFeedSp = false
    autoFeedWl = true
    window.AudioContext = FakeCtxWithWorklet
    globalThis.AudioContext = FakeCtxWithWorklet
    window.AudioWorkletNode = FakeWorkletNode
    globalThis.AudioWorkletNode = FakeWorkletNode
    const voiceWl = await bundle('D:/love/src/lib/voice.js', path.join(here, 'voice-wl.bundle.cjs'))
    const t1g = Date.now()
    const recWl = await voiceWl.startRecording()
    autoFeedWl = false
    feedWl(449)
    const rw = await recWl.stop()
    ok(
      rw.seconds === 1 && recorderLog.length === before + 1,
      `SP 哑火自动换 AudioWorklet 采集（耗时 ${Date.now() - t1g}ms，未动用兜底）`,
    )
    const dvw = await blobView(rw.blob)
    ok(wavStr(dvw, 0, 4) === 'RIFF' && dvw.getUint32(24, true) === 16000, 'worklet 数据编码为 16k WAV')
    delete window.AudioWorkletNode
    delete globalThis.AudioWorkletNode
    attachAudioStub()
    autoFeedSp = true
  }

  // 1h. 「录多久都太短」根因：ctx 初始挂起（如先听过语音再录音），resume+解锁后出数据
  {
    window.AudioContext = FakeCtxSuspend
    globalThis.AudioContext = FakeCtxSuspend
    const voiceS = await bundle('D:/love/src/lib/voice.js', path.join(here, 'voice-suspend.bundle.cjs'))
    const t1h = Date.now()
    const recS = await voiceS.startRecording()
    autoFeedSp = false
    feedPcm(449)
    const rs = await recS.stop()
    ok(
      rs.seconds === 1 && recorderLog.length === before + 1 && recS.mime === 'audio/wav',
      `挂起 ctx 被 resume+解锁救活，未降级（耗时 ${Date.now() - t1h}ms, seconds=${rs.seconds}, mime=${recS.mime}, mr累计增幅=${recorderLog.length - before}）`,
    )
    attachAudioStub()
    autoFeedSp = true
  }
  detachAudioStub() // 组 1 结束彻底摘桩，组 1B（无 AudioContext 的老浏览器）才成立
}

// ============================================================
console.log('\n场景组 1B：MediaRecorder 兜底（无 AudioContext 的老浏览器）')

{
  const voice = await bundle('D:/love/src/lib/voice.js', path.join(here, 'voice-mr.bundle.cjs'))

  // 1Ba. 兜底引擎选择：仍优先 audio/mp4
  const rec = await voice.startRecording()
  ok(recorderLog[0]?.mimeArg === 'audio/mp4', '兜底时仍优先选 audio/mp4')
  ok(rec.ext === 'm4a', '扩展名为 m4a')
  let r = await rec.stop()
  ok(r.seconds >= 0 && r.blob instanceof window.Blob, '正常 onstop 路径 resolve')
  await sleep(60)

  // 1Bb. onstop 挂起 + 数据迟到 600ms → 兜底出结果，数据不丢
  fireStop = false
  lateDataMs = 600
  const rec2 = await voice.startRecording()
  await sleep(700)
  r = await rec2.stop()
  ok(r.blob.size > 0, '迟到的 dataavailable 被等到，blob 不为空')
  fireStop = true
  lateDataMs = 0

  // 1Bc. recorder.stop() 抛异常（已 inactive）→ 立即 resolve
  const rec3 = await voice.startRecording()
  rec3.cancel && rec3.cancel()
  r = await rec3.stop()
  ok(r && typeof r.seconds === 'number', 'stop() 抛异常也能 resolve')

  // 1Bd. 极端 iOS：数据永远不来 → 如实返回空 blob（不悬挂、不假装成功）
  sendData = false
  fireStop = false
  const rec4 = await voice.startRecording()
  await sleep(500)
  r = await rec4.stop()
  ok(r.blob.size === 0, '确无数据时如实返回空 blob（UI 层提示重录）')
  sendData = true
  fireStop = true
}

// ============================================================
console.log('\n场景组 2：录音弹窗（WAV 主路）')

// 需要媒体元素方法可用（VoiceNote 试听）
window.HTMLMediaElement.prototype.load = function () {}
window.HTMLMediaElement.prototype.play = function () { return Promise.resolve() }
window.HTMLMediaElement.prototype.pause = function () {}

{
  attachAudioStub()
  autoFeedSp = true
  const Modal = (await bundle('D:/love/src/components/VoiceRecorderModal.jsx', path.join(here, 'recorder-modal.bundle.cjs'))).default

  // 2a. 正常路径：首包门闩放行 → 录音期间喂 PCM → 录好了 → 处理中… → 试听(发出去)
  procLog.length = 0
  const h1 = await mount(Modal, { open: true, onClose: () => {}, onSend: async () => {} })
  await tick(50)
  findBtn('开始录音').click()
  await tick(300) // 启动麦克风 + 首包门闩（自动喂帧 10ms + 门闩轮询 80ms）
  ok(bodyText().includes('正在录音'), '进入录音中')
  await sleep(1200)
  autoFeedSp = false
  feedPcm(449) // 门闩帧 1 + 449 = 1.2s@48kHz
  findBtn('录好了').click()
  await tick(15)
  ok(bodyText().includes('处理中'), '点击后立刻出现「处理中」反馈')
  await tick(150)
  ok(bodyText().includes('发出去'), 'WAV 编码完成 → 进入试听（发布按钮出现）')
  await h1.unmount()
  autoFeedSp = true

  // 2b. 太短：门闩只给了 1 帧（128 样本 ≈ 0.003s）→ 秒数 0 →「太短啦」
  const h3 = await mount(Modal, { open: true, onClose: () => {}, onSend: async () => {} })
  await tick(50)
  findBtn('开始录音').click()
  await tick(300)
  findBtn('录好了').click()
  await tick(250)
  ok(bodyText().includes('太短啦'), '不足 1 秒提示太短')
  await h3.unmount()

  // 2c. 双引擎全哑火（iOS 挂起救不活）→ 弹窗流程内自动换 MediaRecorder，录音照常可用
  const before = recorderLog.length
  autoFeedSp = false
  autoFeedWl = false
  const h5 = await mount(Modal, { open: true, onClose: () => {}, onSend: async () => {} })
  await tick(50)
  findBtn('开始录音').click()
  await tick(40)
  ok(bodyText().includes('正在启动麦克风'), '引擎切换期间显示启动中反馈')
  await sleep(2600) // SP 门闩 2s → pcmDead → MediaRecorder
  ok(recorderLog.length === before + 1, 'PCM 哑火后弹窗流程自动换 MediaRecorder')
  ok(bodyText().includes('正在录音'), '降级后正常进入录音界面')
  await sleep(1100)
  findBtn('录好了').click()
  await tick(120)
  ok(bodyText().includes('发出去'), '降级引擎完整走通录好→试听')
  await h5.unmount()
  autoFeedSp = true
  autoFeedWl = true
  detachAudioStub()
}

// ============================================================
console.log('\n场景组 2B：录音弹窗走 MediaRecorder 兜底')

{
  const Modal = (await bundle('D:/love/src/components/VoiceRecorderModal.jsx', path.join(here, 'recorder-modal.bundle.cjs'))).default

  // 2Ba. onstop 挂起 + 数据迟到：录 1.2s → 录好了 → 兜底进入试听，绝不卡死
  fireStop = false
  lateDataMs = 600
  recorderLog.length = 0
  const h2 = await mount(Modal, { open: true, onClose: () => {}, onSend: async () => {} })
  await tick(50)
  findBtn('开始录音').click()
  await tick(80)
  await sleep(1200)
  const t0 = Date.now()
  findBtn('录好了').click()
  await sleep(4300)
  ok(Date.now() - t0 < 5000 && bodyText().includes('发出去'), `onstop 挂起兜底进入试听（耗时 ${Date.now() - t0}ms）`)
  ok(!bodyText().includes('正在录音'), '不再卡在录音界面')
  await h2.unmount()
  fireStop = true
  lateDataMs = 0

  // 2Bb. 数据全丢（极端 iOS 偶发）：明确提示重录，不进试听
  sendData = false
  fireStop = false
  const h4 = await mount(Modal, { open: true, onClose: () => {}, onSend: async () => {} })
  await tick(50)
  findBtn('开始录音').click()
  await tick(80)
  await sleep(1100) // 秒数够长，排除「太短」分支，只考察空数据
  findBtn('录好了').click()
  await sleep(5600) // 3.5s 兜底 + 空数据重试窗口 1.4s
  ok(bodyText().includes('没录上声音'), '空数据提示重录而不是进试听')
  ok(!bodyText().includes('发出去'), '空数据不进入试听界面')
  await h4.unmount()
  sendData = true
  fireStop = true
}

// ============================================================
console.log('\n场景组 3：彻底删除——update 命中 vs 被 RLS 静默过滤')

// hooks stub：useCollection 返回可变集合
globalThis.__COLLECTIONS__ = {}
globalThis.__RELOADS__ = 0
const hooksStub = `
export function useCollection(table, _coupleId, _opts) {
  return {
    rows: globalThis.__COLLECTIONS__[table] || [],
    loading: false,
    reload: () => { globalThis.__RELOADS__ += 1 },
  }
}
// 分页版：测试数据量小，直接全量返回（hasMore=false，LoadMore 不触发）
export function usePagedCollection(table, _coupleId, _opts) {
  return {
    rows: globalThis.__COLLECTIONS__[table] || [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    reload: () => { globalThis.__RELOADS__ += 1 },
    loadMore: () => {},
  }
}
export const NOTE_COLORS = [{ bg: '#fdf6e3', border: '#eee0c9' }]
export function formatDateTime(iso) { return new Date(iso).toISOString() }
export function todayStr() { return '2026-10-10' }
`
const supaStub = `
export const supabase = globalThis.__SUPA__
`
const storeStub = `
export function StoreProvider({ children }) { return children }
export function useStore() { return globalThis.__STORE__ }
`

// supabase stub：message_hidden 支持 upsert / update().eq().eq().select()
let updateResult = { data: [{ id: 'h1' }], error: null }
let lastUpdate = null
const hiddenDb = []
const __SUPA__ = {
  from: (t) => {
    const q = {
      update(p) {
        q._p = p
        return q
      },
      upsert(p) {
        q._p = p
        q._upsert = true
        return q
      },
      eq(col, val) {
        q._eq = q._eq || []
        q._eq.push([col, val])
        return q
      },
      delete() {
        return q
      },
      select() {
        q._select = true
        return q
      },
    }
    q.then = (res, rej) => {
      return (async () => {
        if (t === 'message_hidden' && q._upsert) {
          const key = q._p.message_id + '|' + q._p.user_id
          const row = hiddenDb.find((r) => r.message_id + '|' + r.user_id === key)
          if (row) {
            Object.assign(row, q._p)
            return { data: null, error: { message: 'conflict-update-not-tested-here' } }
          }
          hiddenDb.push({ id: 'h' + (hiddenDb.length + 1), permanent: false, purged_at: null, created_at: new Date().toISOString(), ...q._p })
          return { data: null, error: null }
        }
        if (t === 'message_hidden' && q._p && q._select) {
          lastUpdate = { payload: q._p, eq: q._eq }
          if (updateResult.error) return { data: null, error: updateResult.error }
          // 模拟数据库：RLS 静默过滤（data 空）时 patch 不会生效，命中才应用
          if (updateResult.data && updateResult.data.length > 0) {
            hiddenDb.forEach((r) => {
              if (q._eq.every(([c, v]) => r[c] === v)) Object.assign(r, q._p)
            })
          }
          return { data: updateResult.data, error: null }
        }
        return { data: null, error: null }
      })().then(res, rej)
    }
    return q
  },
  storage: {
    from: () => ({ getPublicUrl: (p) => ({ data: { publicUrl: 'http://x/voice/' + p } }) }),    from: () => ({
      getPublicUrl: (p) => ({ data: { publicUrl: 'http://x/voice/' + p } }),
      createSignedUrl: async (p) => ({ data: { signedUrl: 'http://x/voice/sign/' + p } }),
      createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: 'http://x/voice/sign/' + p })), error: null }),
    }),
  },
}

const msgsDb = [
  { id: 'msg-mine', couple_id: 'c1', author_user_id: 'u1', voice_path: 'a.m4a', voice_seconds: 6, created_at: '2026-10-09T10:00:00Z' },
  { id: 'msg-partner', couple_id: 'c1', author_user_id: 'u2', voice_path: 'b.m4a', voice_seconds: 9, created_at: '2026-10-09T11:00:00Z' },
]
function seedCollections() {
  hiddenDb.length = 0
  hiddenDb.push({
    id: 'h1',
    couple_id: 'c1',
    message_id: 'msg-partner',
    user_id: 'u1',
    permanent: true,
    purged_at: null,
    created_at: new Date().toISOString(),
  })
  globalThis.__COLLECTIONS__ = {
    messages: [...msgsDb],
    message_hidden: hiddenDb,
    message_comments: [],
  }
}
globalThis.__STORE__ = { coupleId: 'c1', user: { id: 'u1' }, members: [] }
globalThis.__SUPA__ = __SUPA__

{
  const Messages = (
    await bundle(
      'D:/love/src/views/Messages.jsx',
      path.join(here, 'messages-voice.bundle.cjs'),
      [
        {
          name: 'stubs',
          setup(b) {
            b.onResolve({ filter: /supabase\.js$/ }, () => ({ path: 'supa-stub', namespace: 'stub' }))
            b.onResolve({ filter: /hooks\.js$/ }, () => ({ path: 'hooks-stub', namespace: 'stub' }))
            b.onResolve({ filter: /store\.jsx$/ }, () => ({ path: 'store-stub', namespace: 'stub' }))
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
              contents: args.path === 'supa-stub' ? supaStub : args.path === 'hooks-stub' ? hooksStub : storeStub,
              loader: 'js',
            }))
          },
        },
      ],
    )
  ).default

  const openTrashAndPurge = async () => {
    seedCollections()
    clearToasts()
    const h = await mount(Messages, {})
    await tick(60)
    findBtn('最近删除').click()
    await tick(40)
    ok(bodyText().includes('彻底删除'), '最近删除里出现待彻底删除条目')
    findBtn('彻底删除').click()
    await tick(40)
    // 此时页面有两个「彻底删除」：回收站条目 + 确认弹窗，点最后一个（确认弹窗的）
    const purgeBtns = [...document.querySelectorAll('button')].filter((b) => b.textContent.includes('彻底删除'))
    purgeBtns[purgeBtns.length - 1].click()
    await tick(80)
    return h
  }

  // 3a. update 命中：purged_at 写入 + 无 alert
  updateResult = { data: [{ id: 'h1' }], error: null }
  let h = await openTrashAndPurge()
  ok(!!lastUpdate?.payload?.purged_at, 'update 带上了 purged_at')
  ok(
    lastUpdate?.eq?.some(([c, v]) => c === 'message_id' && v === 'msg-partner') &&
      lastUpdate?.eq?.some(([c, v]) => c === 'user_id' && v === 'u1'),
    'update 按 message_id + user_id 限定',
  )
  ok(toastTexts().length === 0, `正常路径不弹错误提示（toasts=${JSON.stringify(toastTexts())}）`)
  ok(hiddenDb[0].purged_at, 'stub 数据库已打上 purged_at')
  await h.unmount()

  // 3b. update 被 RLS 静默过滤（data 空、error 空）→ 明确提示，不再无声失败
  updateResult = { data: [], error: null }
  h = await openTrashAndPurge()
  ok(
    toastTexts().some((a) => a.includes('彻底删除没有生效') && a.includes('025_message_hidden_policy')),
    `静默过滤时提示执行迁移（toasts=${JSON.stringify(toastTexts())}）`,
  )
  ok(!hiddenDb[0].purged_at, 'RLS 拦截时 purged_at 未被误标')
  await h.unmount()

  // 3c. update 报错 → 提示错误信息
  updateResult = { data: null, error: { message: 'network timeout' } }
  h = await openTrashAndPurge()
  ok(
    toastTexts().some((a) => a.includes('彻底删除失败') && a.includes('network timeout')),
    `update 报错时可见提示（toasts=${JSON.stringify(toastTexts())}）`,
  )
  await h.unmount()
}

// ============================================================
console.log('\n场景组 4：VoiceNote 双引擎播放（media 失败自动降级 WebAudio）')

// WebAudio / fetch 桩
let decodeShouldFail = false
const startedNodes = []
const ctxInstances = []
let fetchCalls = []
class FakeSrcNode {
  constructor() {
    this.buffer = null
    this.startedArgs = null
    this.stopped = 0
    this.onended = null
  }
  start(...args) {
    this.startedArgs = args
    startedNodes.push(this)
  }
  stop() {
    this.stopped++
  }
  connect() {
    return this
  }
  disconnect() {}
}
class FakeCtx {
  constructor() {
    this.state = 'suspended'
    this.currentTime = 0
    this.destination = {}
    ctxInstances.push(this)
  }
  resume() {
    this.state = 'running'
    return Promise.resolve()
  }
  decodeAudioData(_buf, ok, err) {
    if (decodeShouldFail) {
      setTimeout(() => err(new Error('decode-fail')), 0)
      return
    }
    const audio = { duration: 12.5, sampleRate: 44100 }
    setTimeout(() => ok(audio), 0)
  }
  createBufferSource() {
    return new FakeSrcNode()
  }
}
window.AudioContext = FakeCtx
window.fetch = async (url) => {
  fetchCalls.push(String(url))
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(16) }
}

{
  const VoiceNote = (await bundle('D:/love/src/components/VoiceNote.jsx', path.join(here, 'voice-note.bundle.cjs'))).default

  // 4a. media 引擎正常播放（play resolve + play 事件）
  let h = await mount(VoiceNote, { src: 'http://x/voice/a.m4a', seconds: 8 })
  await tick(40)
  ok(bodyText().includes('8″'), '正常显示秒数')
  let audio = document.querySelector('audio')
  audio.play = () => {
    setTimeout(() => audio.dispatchEvent(new window.Event('play')), 0)
    return Promise.resolve()
  }
  findBtn('播放').click()
  await tick(40)
  ok(!!findBtn('暂停'), 'media 引擎播放中（▶→⏸）')
  ok(!bodyText().includes('播放失败'), '正常播放无错误提示')
  await h.unmount()

  // 4b. play() 被拒（iOS NotSupportedError）→ 自动降级 WebAudio，从头播
  startedNodes.length = 0
  fetchCalls = []
  h = await mount(VoiceNote, { src: 'http://x/voice/b.m4a', seconds: 8 })
  await tick(40)
  audio = document.querySelector('audio')
  audio.play = () => Promise.reject(new Error('NotSupportedError'))
  findBtn('播放').click()
  await tick(100)
  ok(fetchCalls.includes('http://x/voice/b.m4a'), 'play 被拒后自动 fetch 语音数据')
  ok(startedNodes.length === 1 && startedNodes[0].startedArgs[0] === 0, 'WebAudio BufferSource 从头启动')
  ok(!!findBtn('暂停'), `降级后直接进入播放状态（用户无感知）`)
  ok(!bodyText().includes('播放失败'), '降级成功不显示播放失败')
  await h.unmount()

  // 4c. 播放中 error 事件（iOS Format error 常见形态）→ 从断点续播
  startedNodes.length = 0
  fetchCalls = []
  h = await mount(VoiceNote, { src: 'http://x/voice/c.m4a', seconds: 8 })
  await tick(40)
  audio = document.querySelector('audio')
  audio.play = () => {
    setTimeout(() => audio.dispatchEvent(new window.Event('play')), 0)
    return Promise.resolve()
  }
  findBtn('播放').click()
  await tick(30)
  audio.currentTime = 3.2
  audio.dispatchEvent(new window.Event('error'))
  await tick(100)
  ok(
    startedNodes.length === 1 && Math.abs((startedNodes[0].startedArgs || [])[1] - 3.2) < 0.01,
    `播放中报错自动降级并从断点 3.2s 续播（实际 ${(startedNodes[0]?.startedArgs || [])[1]}）`,
  )
  ok(!!findBtn('暂停'), '续播中状态正常')
  await h.unmount()

  // 4d. WebAudio 解码也失败 → 「播放失败」可见
  decodeShouldFail = true
  startedNodes.length = 0
  h = await mount(VoiceNote, { src: 'http://x/voice/d.m4a', seconds: 8 })
  await tick(40)
  audio = document.querySelector('audio')
  audio.play = () => Promise.reject(new Error('NotSupportedError'))
  findBtn('播放').click()
  await tick(100)
  ok(bodyText().includes('播放失败'), '双引擎都失败时显示「播放失败」')
  // 4e. 失败态点按 → 走 WebAudio 重试（解码恢复）
  decodeShouldFail = false
  startedNodes.length = 0
  findBtn('播放').click()
  await tick(100)
  ok(startedNodes.length === 1, '失败态点按自动走 WebAudio 重试')
  ok(!bodyText().includes('播放失败'), '重试成功后错误清除')
  await h.unmount()

  // 4f. WebAudio 播放进度推进 → 波形染色
  startedNodes.length = 0
  h = await mount(VoiceNote, { src: 'http://x/voice/e.m4a', seconds: 12 })
  await tick(40)
  audio = document.querySelector('audio')
  audio.play = () => Promise.reject(new Error('NotSupportedError'))
  findBtn('播放').click()
  await tick(100)
  ok(startedNodes.length === 1, '4f 前置：WebAudio 已启动')
  ctxInstances[0].currentTime += 2 // 模拟播了 2 秒（duration 12.5 → progress≈0.16）
  await sleep(600) // 等进度 interval（200ms）刷新
  const dyed = document.querySelectorAll('.bg-rosy').length
  ok(dyed >= 3, `WebAudio 播放进度驱动波形染色（染色 ${dyed} 根）`)
  await h.unmount()
}

// ============================================================
console.log(`\n结果: ${pass} 通过, ${failures.length} 失败`)
if (failures.length) {
  console.log('失败项:')
  failures.forEach((f) => console.log('  ✗', f))
  process.exit(1)
}
