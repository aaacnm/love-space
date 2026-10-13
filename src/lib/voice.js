// 录音工具：WebAudio PCM 直录 → WAV 编码（保险牌）+ AudioWorklet/MediaRecorder 级联兜底
//
// 为什么不用 MediaRecorder 当主路（历史教训，iOS Safari 一堆怪癖）：
//   - start(timeslice) 定时切片常完全不触发 → 数据全丢（「没录上声音」）
//   - stop 事件偶发不触发，dataavailable 可能迟到
//   - 录出的 fragmented MP4，iOS 的 <audio> 和 decodeAudioData 都可能解不了
//     （「对方发的语音听不了」换了几轮 MIME 还是复发）
//
// PCM 主路自己也踩过一次坑（第三轮教训）：
//   AudioContext 若处于挂起态（被 VoiceNote 提前创建 / 来电中断 / 后台切回），
//   onaudioprocess 一个字节都不产生，而 WAV 头至少 44 字节、blob.size 检查形同虚设，
//   秒数永远是 0 → 「无论录多久都提示太短」。
//   对策（四层）：
//   1. AudioContext 的创建/恢复放在用户手势的同步栈里（startRecording 由点击触发，
//      第一行同步执行），并播一个 1 样本静音 buffer「解锁」iOS 音频管线；
//   2. 首包门闩：startRecording 返回前必须等到第一批 PCM，期间反复 resume+解锁；
//   3. 引擎级联：ScriptProcessor（2s 无数据）→ AudioWorklet（2s 无数据）→ 上层降级 MediaRecorder；
//   4. 一个样本都没收到时如实返回空 blob，UI 走「没录上声音」提示——绝不给假 WAV。
//
// 时长统计：PCM 样本数 / 采样率，精确且不受容器元数据影响。
// 体积：录音后统一重采样到 16kHz 单声道 16bit → 32KB/s，60 秒约 1.9MB。

const MAX_SECONDS_HARD = 180 // 硬上限：防止忘记停止把内存吃爆
const TARGET_RATE = 16000

const pcmSupported = () =>
  typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext)

const mrSupported = () =>
  typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'

// 任一引擎可用即支持录音
export function recorderSupported() {
  return (
    typeof window !== 'undefined' &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
    (pcmSupported() || mrSupported())
  )
}

function friendlyError(e) {
  if (e && e.name === 'NotAllowedError') return '麦克风权限被拒绝了，请在浏览器设置里允许后重试'
  if (e && e.name === 'NotFoundError') return '没有检测到可用的麦克风'
  if (e && e.name === 'NotReadableError') return '麦克风被其他应用占用中'
  return (e && e.message) || '录音失败，请重试'
}

// ---------------- WAV 编码（16bit PCM 单声道） ----------------
export function encodeWav(samples, sampleRate) {
  const n = samples.length
  const bytes = n * 2
  const buf = new ArrayBuffer(44 + bytes)
  const v = new DataView(buf)
  const wstr = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  wstr(0, 'RIFF')
  v.setUint32(4, 36 + bytes, true)
  wstr(8, 'WAVE')
  wstr(12, 'fmt ')
  v.setUint32(16, 16, true) // fmt 块长度
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // 单声道
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true) // 字节率 = rate * 2 bytes
  v.setUint16(32, 2, true) // 块对齐
  v.setUint16(34, 16, true) // 位深
  wstr(36, 'data')
  v.setUint32(40, bytes, true)
  let off = 44
  for (let i = 0; i < n; i++) {
    let s = samples[i]
    s = s < -1 ? -1 : s > 1 ? 1 : s
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }
  return buf
}

// ---------------- AudioWorklet 采集代码（Blob URL 注入） ----------------
const WORKLET_CODE = `class RecProc extends AudioWorkletProcessor{process(inputs){const c=inputs[0]&&inputs[0][0];if(c&&c.length)this.port.postMessage(c.slice(0));return true}}registerProcessor('rec-proc',RecProc)`
let workletUrl = null

async function ensureWorkletModule(ctx) {
  if (!ctx.audioWorklet || typeof window.AudioWorkletNode !== 'function') {
    throw new Error('AudioWorklet 不可用')
  }
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }))
  }
  await ctx.audioWorklet.addModule(workletUrl)
}

// ---------------- 主路：WebAudio PCM 录音 ----------------
async function startPcmRecording() {
  // 关键：getAudioCtx() 必须在任何 await 之前同步执行——startRecording 由点击触发，
  // 此时还处于用户手势栈内，创建/恢复 AudioContext 才会被 iOS 放行；
  // 若放到 getUserMedia 之后，手势标记可能已失效，ctx 永远挂起、一个字节都收不到。
  const ctx = getAudioCtx()
  if (!ctx) {
    const err = new Error('WebAudio 不可用')
    err.noWebAudio = true
    throw err
  }

  // iOS 解锁：往 destination 塞一个 1 样本的静音 buffer，强制音频管线真正跑起来。
  // state=running 也不保险——被挂起过的 ctx 常常并不启动渲染循环。
  function unlock() {
    try {
      const b = ctx.createBuffer(1, 1, ctx.sampleRate)
      const s = ctx.createBufferSource()
      s.buffer = b
      s.connect(ctx.destination)
      s.start(0)
    } catch {
      /* 忽略：unlock 只是尽力而为 */
    }
  }
  function revive() {
    if (ctx.state !== 'running') {
      try {
        ctx.resume()
      } catch {
        /* 忽略 */
      }
    }
    unlock()
  }
  revive() // 手势栈内的第一次恢复 + 解锁

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    throw new Error(friendlyError(e))
  }

  const source = ctx.createMediaStreamSource(stream)
  const mute = ctx.createGain()
  mute.gain.value = 0
  source.connect(mute)
  mute.connect(ctx.destination) // iOS 上不连到 destination 回调不跑；gain=0 防回声

  const chunks = []
  let totalLen = 0
  let captureNode = null
  let stopped = false
  let watchdog = null

  function onPcm(data) {
    const copy = new Float32Array(data.length)
    copy.set(data)
    chunks.push(copy)
    totalLen += data.length
    if (totalLen >= MAX_SECONDS_HARD * ctx.sampleRate) hardStop()
  }

  function detachCapture() {
    if (!captureNode) return
    captureNode.onaudioprocess = null
    if (captureNode.port) captureNode.port.onmessage = null
    try {
      captureNode.disconnect()
    } catch {
      /* 忽略 */
    }
    captureNode = null
  }

  function startScriptProcessor() {
    const node = ctx.createScriptProcessor(4096, 1, 1)
    node.onaudioprocess = (e) => onPcm(e.inputBuffer.getChannelData(0))
    source.connect(node)
    node.connect(mute)
    captureNode = node
  }

  async function startWorklet() {
    await ensureWorkletModule(ctx)
    const node = new window.AudioWorkletNode(ctx, 'rec-proc')
    node.port.onmessage = (e) => {
      if (e.data && e.data.length) onPcm(e.data)
    }
    source.connect(node)
    node.connect(mute)
    captureNode = node
  }

  function teardownAll() {
    stopped = true
    detachCapture()
    if (watchdog) {
      clearInterval(watchdog)
      watchdog = null
    }
    try {
      source.disconnect()
    } catch {
      /* 忽略 */
    }
    try {
      mute.disconnect()
    } catch {
      /* 忽略 */
    }
    stream.getTracks().forEach((t) => t.stop())
  }

  // 首包门闩：等到第一批 PCM 才算引擎活着；期间反复 resume+解锁（iOS 挂起态自救）
  function waitFirstData(ms) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now()
      const revives = []
      let settled = false
      const settle = (fn, arg) => {
        if (settled) return
        settled = true
        clearInterval(iv)
        revives.forEach(clearTimeout)
        fn(arg)
      }
      const iv = setInterval(() => {
        if (chunks.length > 0) settle(resolve)
        else if (Date.now() - t0 > ms) settle(reject, new Error('no pcm data'))
      }, 80)
      revives.push(setTimeout(() => !chunks.length && revive(), 600))
      revives.push(setTimeout(() => !chunks.length && revive(), 1300))
    })
  }

  // 引擎级联：ScriptProcessor →（ctx 还活着但 SP 哑火时）AudioWorklet → 都哑火则抛 pcmDead 交上层降级
  try {
    startScriptProcessor()
    await waitFirstData(2000)
  } catch {
    detachCapture()
    revive()
    let rescued = false
    // ctx 已被反复复活仍是挂起态的话，worklet 挂在同一个 ctx 上也是哑火，不必再试
    if (ctx.state === 'running') {
      try {
        await startWorklet()
        await waitFirstData(2000)
        rescued = true
      } catch {
        detachCapture()
      }
    }
    if (!rescued) {
      teardownAll()
      const e = new Error('麦克风数据通道不可用，正在换备用方式')
      e.pcmDead = true
      throw e
    }
  }

  // 录音中看门狗：数据流中途断掉（来电中断/切后台）→ 周期性尝试复活
  let lastCount = chunks.length
  let lastAt = Date.now()
  watchdog = setInterval(() => {
    if (stopped) return
    if (chunks.length > lastCount) {
      lastCount = chunks.length
      lastAt = Date.now()
    } else if (Date.now() - lastAt > 3000) {
      revive()
    }
  }, 1000)

  const merge = () => {
    const raw = new Float32Array(totalLen)
    let off = 0
    for (const c of chunks) {
      raw.set(c, off)
      off += c.length
    }
    return raw
  }

  // 重采样到 16k：OfflineAudioContext 最稳（iOS 支持好）；不可用/超时就按原始采样率直编
  const resample = async (raw, fromRate) => {
    if (fromRate === TARGET_RATE) return { data: raw, rate: fromRate }
    const OffCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext
    if (!OffCtor) return { data: raw, rate: fromRate }
    const length = Math.max(1, Math.ceil((raw.length * TARGET_RATE) / fromRate))
    try {
      const off = new OffCtor(1, length, TARGET_RATE)
      const buf = off.createBuffer(1, raw.length, fromRate)
      if (buf.copyToChannel) buf.copyToChannel(raw, 0)
      else buf.getChannelData(0).set(raw)
      const node = off.createBufferSource()
      node.buffer = buf
      node.connect(off.destination)
      node.start()
      const rendered = await Promise.race([
        off.startRendering(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('resample timeout')), 3000)),
      ])
      return { data: rendered.getChannelData(0), rate: TARGET_RATE }
    } catch {
      return { data: raw, rate: fromRate } // 任何意外：原始采样率直编，音质不变只是文件大些
    }
  }

  return {
    mime: 'audio/wav',
    ext: 'wav',
    stop: async () => {
      teardownAll()
      const raw = merge()
      if (!raw.length) {
        // 一个样本都没收到（正常被首包门闩拦住到不了这）：如实交空 blob，
        // 让 UI 走「没录上声音」——绝不给只有 44 字节头的假 WAV（「永远太短」的根源）
        return { blob: new Blob([], { type: 'audio/wav' }), seconds: 0 }
      }
      const seconds = Math.max(0, Math.round(raw.length / ctx.sampleRate))
      const { data, rate } = await resample(raw, ctx.sampleRate)
      const blob = new Blob([encodeWav(data, rate)], { type: 'audio/wav' })
      return { blob, seconds }
    },
    cancel: teardownAll,
  }

  function hardStop() {
    // 由 onaudioprocess 触发的到点自停：只收轨道，数据留待 stop() 收尾
    stream.getTracks().forEach((t) => t.stop())
  }
}

// ---------------- 兜底：MediaRecorder（PCM 引擎全哑火的设备） ----------------
const MIME_CANDIDATES = [
  { mime: 'audio/mp4', ext: 'm4a' },
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/webm', ext: 'webm' },
  { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
]

function pickMime() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return null
  return MIME_CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c.mime)) || null
}

async function startMediaRecorderRecording() {
  const picked = pickMime()
  if (!picked) throw new Error('当前浏览器不支持录音')

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    throw new Error(friendlyError(e))
  }

  const recorder = new MediaRecorder(stream, { mimeType: picked.mime })
  const chunks = []
  const startedAt = performance.now()

  recorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size) chunks.push(e.data)
  })
  // 不用 start(timeslice)：iOS Safari 定时切片常完全不触发
  recorder.start()

  const teardown = () => stream.getTracks().forEach((t) => t.stop())

  return {
    mime: picked.mime,
    ext: picked.ext,
    stop: () =>
      new Promise((resolve) => {
        let done = false
        let emptyTries = 0
        const finish = () => {
          if (done) return
          if (!chunks.length && emptyTries < 4) {
            emptyTries++
            setTimeout(finish, 350)
            return
          }
          done = true
          teardown()
          const seconds = Math.max(0, Math.round((performance.now() - startedAt) / 1000))
          resolve({ blob: new Blob(chunks, { type: recorder.mimeType || picked.mime }), seconds })
        }
        if (recorder.state === 'inactive' || recorder.stream !== stream) {
          finish()
          return
        }
        recorder.addEventListener('stop', finish, { once: true })
        try {
          recorder.stop()
        } catch {
          finish()
        }
        setTimeout(() => {
          if (!done) teardown()
        }, 1200)
        setTimeout(finish, 3500)
      }),
    cancel: () => {
      try {
        recorder.stop()
      } catch {
        /* 忽略 */
      }
      teardown()
    },
  }
}

/**
 * 开始录音。
 * @returns {Promise<{mime: string, ext: string, stop: () => Promise<{blob: Blob, seconds: number}>, cancel: () => void}>}
 */
export async function startRecording() {
  if (!recorderSupported()) throw new Error('当前浏览器不支持录音')
  if (pcmSupported()) {
    try {
      return await startPcmRecording()
    } catch (e) {
      // noWebAudio：连 AudioContext 都没有的老设备；pcmDead：有 ctx 但 PCM 通道全哑火
      //（iOS 挂起态救不活 / SP+Worklet 都被节流）。两种情况都降级 MediaRecorder
      if ((e && (e.noWebAudio || e.pcmDead)) && mrSupported()) return startMediaRecorderRecording()
      throw e
    }
  }
  return startMediaRecorderRecording()
}

// ---------------- 播放：Web Audio 降级引擎 ----------------
// <audio> 解不了的老格式（历史 fragmented MP4 消息）由 decodeAudioData 兜底；
// 新录音是 WAV，<audio> 直接就能播。

let sharedCtx = null

/** 共享 AudioContext（iOS 上必须在用户手势内同步创建/恢复） */
export function getAudioCtx() {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  if (!sharedCtx) {
    try {
      sharedCtx = new AC()
    } catch {
      return null
    }
  }
  // iOS 还有 'interrupted'（来电/Siri 中断）态，只要不是 running 就尝试恢复
  if (sharedCtx.state !== 'running') {
    try {
      sharedCtx.resume()
    } catch {
      /* 忽略 */
    }
  }
  return sharedCtx
}

/** 把语音地址（blob: 或 http(s)）解成 AudioBuffer；失败抛错 */
export async function decodeVoice(src) {
  const ctx = getAudioCtx()
  if (!ctx) throw new Error('WebAudio 不可用')
  const res = await window.fetch(src)
  if (!res.ok) throw new Error(`语音下载失败(${res.status})`)
  const buf = await res.arrayBuffer()
  // Safari 老版本只有回调形式，包一层兼容
  return await new Promise((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(buf, resolve, reject)
      if (p && typeof p.then === 'function') p.then(resolve, reject)
    } catch (e) {
      reject(e)
    }
  })
}
