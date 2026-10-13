import { useEffect, useRef, useState } from 'react'
import { decodeVoice, getAudioCtx } from '../lib/voice.js'

export function fmtSec(s) {
  const sec = Math.max(0, Math.round(s || 0))
  return sec < 60 ? `${sec}″` : `${Math.floor(sec / 60)}′${String(sec % 60).padStart(2, '0')}″`
}

// 稳定的伪波形（由下标推导，不随机），播放过的部分染色
// 根数别太多：便利贴是两列窄卡，要保证每根还有 3px 左右
const BAR_HEIGHTS = Array.from({ length: 18 }, (_, i) => 30 + ((i * 37 + 13) % 70))

/**
 * 语音气泡：点按播放/暂停，波形按进度染色。
 * 双引擎播放：
 * - 先用 <audio> 元素（桌面/安卓最省事）；
 * - iOS Safari 对 MediaRecorder 录的 fragmented MP4 常报 Format error，
 *   play() 被拒或 error 事件时自动降级 Web Audio（decodeAudioData）续播，
 *   同一份数据 WebAudio 解得动，用户无感知；试听（blob）和远程语音共用。
 * - 两边都失败才显示「播放失败」，点按可再试（走 WebAudio）。
 */
export default function VoiceNote({ src, seconds = 0 }) {
  const ref = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [failed, setFailed] = useState(false)
  const [waiting, setWaiting] = useState(false)

  // WebAudio 引擎的运行时状态（不用 state：避免频繁重渲染，进度单独 setProgress）
  const webRef = useRef({
    mode: 'media', // 'media' | 'web'
    buffer: null, // AudioBuffer
    node: null, // 当前 BufferSourceNode
    offset: 0, // 已播到的秒数（暂停点）
    startedAt: 0, // 本次 start 的 ctx.currentTime
    timer: null, // 进度 interval
    wantPlay: false, // 用户有播放意图（区别于 preload 阶段的报错）
  })

  useEffect(() => {
    setFailed(false)
    setWaiting(false)
    setPlaying(false)
    setProgress(0)
    stopWeb(false)
    Object.assign(webRef.current, { mode: 'media', buffer: null, offset: 0, wantPlay: false })
    // 卸载清理：停掉 WebAudio 的进度 interval 和发声节点（消息列表滚动会频繁挂卸）
    return () => stopWeb(false)
  }, [src])

  const setProgressOf = (elapsed, total) => {
    setProgress(Math.min(1, Math.max(0, elapsed / (total || seconds || 1))))
  }

  // ---------- Web Audio 引擎 ----------
  const stopWeb = (keepOffset) => {
    const w = webRef.current
    if (w.timer) {
      clearInterval(w.timer)
      w.timer = null
    }
    if (w.node) {
      const n = w.node
      w.node = null
      n.onended = null
      try {
        n.stop()
      } catch {
        /* 已停 */
      }
      try {
        n.disconnect()
      } catch {
        /* 忽略 */
      }
    }
    if (!keepOffset) w.offset = 0
  }

  const startWeb = (from) => {
    const w = webRef.current
    const ctx = getAudioCtx()
    if (!ctx || !w.buffer) return
    stopWeb(false)
    const node = ctx.createBufferSource()
    node.buffer = w.buffer
    node.connect(ctx.destination)
    node.onended = () => {
      if (webRef.current.node !== node) return // 主动 pause 触发的 onended，忽略
      stopWeb(false)
      setPlaying(false)
      setProgress(0)
      webRef.current.offset = 0
    }
    node.start(0, Math.min(from, Math.max(0, w.buffer.duration - 0.01)))
    w.node = node
    w.startedAt = ctx.currentTime
    w.offset = from
    w.mode = 'web'
    setPlaying(true)
    setFailed(false)
    setWaiting(false)
    const total = w.buffer.duration
    w.timer = setInterval(() => {
      if (!webRef.current.node) return
      setProgressOf(webRef.current.offset + (ctx.currentTime - webRef.current.startedAt), total)
    }, 200)
  }

  const tryWebAudio = async (from) => {
    const w = webRef.current
    // iOS 解锁：AudioContext 的创建/恢复必须发生在用户手势的同步调用栈里
    getAudioCtx()
    try {
      setWaiting(true)
      if (!w.buffer) w.buffer = await decodeVoice(src)
      startWeb(from)
    } catch {
      setWaiting(false)
      setPlaying(false)
      stopWeb(false)
      w.offset = 0
      setFailed(true)
    }
  }

  // ---------- <audio> 引擎 ----------
  useEffect(() => {
    const a = ref.current
    if (!a) return
    const w = webRef.current
    const onPlay = () => {
      setPlaying(true)
      setFailed(false)
    }
    const onPause = () => {
      if (w.mode !== 'web') setPlaying(false)
    }
    const onEnded = () => {
      if (w.mode === 'web') return
      setPlaying(false)
      setProgress(0)
      try {
        a.currentTime = 0
      } catch {
        /* duration 未就绪时可能抛错，忽略 */
      }
    }
    const onTime = () => {
      if (w.mode === 'web') return
      const total = isFinite(a.duration) && a.duration > 0 ? a.duration : seconds || 1
      setProgress(Math.min(1, a.currentTime / total))
    }
    const onError = () => {
      if (w.mode === 'web') return
      if (w.wantPlay) {
        // 播放中途/起播时坏掉（iOS Format error 多走这里）→ 无缝降级 WebAudio 续播
        const from = isFinite(a.currentTime) && a.currentTime > 0 ? a.currentTime : 0
        tryWebAudio(from)
      } else {
        // 还没点播放就报错（preload 失败）→ 只标记，等点按时走 WebAudio
        setFailed(true)
        setWaiting(false)
        setPlaying(false)
      }
    }
    const onWaiting = () => setWaiting(true)
    const onGoing = () => setWaiting(false)
    a.addEventListener('play', onPlay)
    a.addEventListener('pause', onPause)
    a.addEventListener('ended', onEnded)
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('error', onError)
    a.addEventListener('stalled', onWaiting)
    a.addEventListener('waiting', onWaiting)
    a.addEventListener('playing', onGoing)
    a.addEventListener('canplay', onGoing)
    return () => {
      a.removeEventListener('play', onPlay)
      a.removeEventListener('pause', onPause)
      a.removeEventListener('ended', onEnded)
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('error', onError)
      a.removeEventListener('stalled', onWaiting)
      a.removeEventListener('waiting', onWaiting)
      a.removeEventListener('playing', onGoing)
      a.removeEventListener('canplay', onGoing)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, src])

  const pauseMedia = () => {
    const a = ref.current
    webRef.current.wantPlay = false
    if (a && !a.paused) a.pause()
  }

  const toggle = () => {
    const a = ref.current
    const w = webRef.current
    if (!a && w.mode !== 'web') return

    if (failed) {
      // 之前失败过：重置后直接走 WebAudio（比 media 元素宽容得多）
      setFailed(false)
      setProgress(0)
      w.offset = 0
      pauseMedia()
      tryWebAudio(0)
      return
    }

    if (w.mode === 'web') {
      // 已在 WebAudio 引擎上：暂停/续播
      if (w.node) {
        const elapsed = w.offset + (getAudioCtx()?.currentTime || 0) - w.startedAt
        w.offset = Math.max(0, elapsed)
        stopWeb(true)
        setPlaying(false)
      } else {
        startWeb(w.offset)
      }
      return
    }

    if (!a) return
    if (a.paused) {
      w.wantPlay = true
      setWaiting(true)
      a.play().catch(() => {
        // play 被拒（NotSupportedError / iOS Format error 的另一形态）→ 降级
        tryWebAudio(0)
      })
    } else {
      pauseMedia()
    }
  }

  const hint = failed ? '播放失败' : waiting ? '加载中' : null

  return (
    <div className="flex items-center gap-2.5">
      <button
        onClick={toggle}
        aria-label={playing ? '暂停' : '播放'}
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base shadow-soft transition active:scale-90 ${
          failed ? 'bg-peach text-rosy' : 'bg-white/85'
        }`}
      >
        {failed ? '⚠️' : playing ? '⏸' : waiting && !playing ? '⏳' : '▶'}
      </button>
      <div className="flex h-7 min-w-0 flex-1 items-center gap-[2px] overflow-hidden">
        {BAR_HEIGHTS.map((h, i) => (
          <div
            key={i}
            className={`min-w-[2px] max-w-[5px] flex-1 rounded-full transition-colors duration-150 ${
              failed ? 'bg-rosy/50' : i / BAR_HEIGHTS.length <= progress ? 'bg-rosy' : 'bg-cocoaSoft/25'
            }`}
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
      <span
        className={`shrink-0 text-xs font-bold ${failed ? 'text-rosy' : 'text-cocoaSoft/80'}`}
        title={failed ? '这段语音播放失败，点左侧按钮重试；若一直失败请重新发送一次' : undefined}
      >
        {hint || fmtSec(seconds)}
      </span>
      <audio ref={ref} src={src} preload="metadata" />
    </div>
  )
}
