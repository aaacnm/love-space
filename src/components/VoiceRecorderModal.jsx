import { useEffect, useRef, useState } from 'react'
import { Modal, Button } from './ui.jsx'
import VoiceNote from './VoiceNote.jsx'
import { recorderSupported, startRecording } from '../lib/voice.js'

const MAX_SECONDS = 60
const MIN_SECONDS = 1
const fmtClock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

/**
 * 录音弹窗：待录 → 录音中（计时+自动到点停）→ 试听（重录/发送）
 * onSend({ blob, seconds, ext }) 由父组件负责上传入库
 */
export default function VoiceRecorderModal({ open, onClose, onSend }) {
  const [phase, setPhase] = useState('idle') // idle | recording | preview
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null) // { blob, seconds, ext, url }
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false) // stop 可能要等编码收尾（iOS 上偏慢），给个可见反馈
  const [sendError, setSendError] = useState('') // 发送/上传失败：留在试听界面提示，可重试

  const timerRef = useRef(null)
  const urlRef = useRef(null)
  const recorderRef = useRef(null)
  const openRef = useRef(open) // beginRecording 异步返回时可能已关弹窗（引擎切换最长几秒）
  useEffect(() => {
    openRef.current = open
  }, [open])

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const revokeUrl = () => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }

  // 关闭/打开时复位
  useEffect(() => {
    if (!open) {
      clearTimer()
      recorderRef.current?.cancel()
      recorderRef.current = null
      revokeUrl()
      return
    }
    setPhase('idle')
    setElapsed(0)
    setError('')
    setResult(null)
    setSending(false)
    setStopping(false)
    setSendError('')
  }, [open])

  // 录音中：计时，到 60s 自动停
  useEffect(() => {
    if (phase !== 'recording') return
    clearTimer()
    const startedAt = Date.now()
    timerRef.current = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000)
      setElapsed(sec)
      if (sec >= MAX_SECONDS) stopRecording()
    }, 250)
    return clearTimer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const beginRecording = async () => {
    setError('')
    setPhase('preparing') // 引擎启动+首包确认需要一点时间（通常几十 ms，坏设备上几秒），给可见反馈
    try {
      const rec = await startRecording()
      if (!openRef.current) {
        // 等待期间弹窗已被关掉：放弃这次录音，别把状态写进已卸载的界面
        rec.cancel && rec.cancel()
        return
      }
      recorderRef.current = rec
      setElapsed(0)
      setPhase('recording')
    } catch (e) {
      setError(e.message || '录音失败，请重试')
      setPhase('idle')
    }
  }

  const stopRecording = async () => {
    if (stopping) return
    clearTimer()
    const rec = recorderRef.current
    if (!rec) return
    recorderRef.current = null
    setStopping(true)
    try {
      const { blob, seconds } = await rec.stop()
      if (!blob || !blob.size) {
        // iOS 偶发：切片事件全没触发 → 与其给一个必然播放失败的空文件，不如明确提示
        setError('没录上声音，请再试一次（若反复出现，完全关闭页面后重开）')
        setPhase('idle')
        return
      }
      if (!seconds || seconds < MIN_SECONDS) {
        setError('太短啦，至少录 1 秒')
        setPhase('idle')
        return
      }
      revokeUrl()
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      setResult({ blob, seconds, ext: rec.ext, url })
      setElapsed(seconds)
      setPhase('preview')
    } catch (e) {
      // stop 抛错（编码异常等）也要给交代，别让界面卡在「处理中」
      setError(e.message || '处理录音时出错了，请再试一次')
      setPhase('idle')
    } finally {
      setStopping(false)
    }
  }

  const cancelRecording = () => {
    if (stopping) return
    clearTimer()
    recorderRef.current?.cancel()
    recorderRef.current = null
    setPhase('idle')
    setElapsed(0)
  }
  const reRecord = () => {
    revokeUrl()
    setResult(null)
    setSendError('')
    beginRecording()
  }

  // onSend 抛错 = 发送失败：不关弹窗，错误显示在试听界面，「发出去」可直接重试
  const send = async () => {
    if (!result || sending) return
    setSending(true)
    setSendError('')
    try {
      await onSend(result)
      onClose()
    } catch (e) {
      setSendError((e && e.message) || '发送失败，请检查网络后重试')
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal open={open} onClose={phase === 'recording' || sending ? undefined : onClose} title="🎙️ 说句话">
      <div className="space-y-4">
        {!recorderSupported() ? (
          <p className="rounded-2xl bg-cream px-4 py-6 text-center text-sm leading-relaxed text-cocoaSoft">
            当前浏览器不支持录音
            <br />
            换 Chrome / Safari 最新版试试，或直接写文字纸条
          </p>
        ) : error ? (
          <div className="space-y-4">
            <p className="rounded-2xl bg-cream px-4 py-6 text-center text-sm leading-relaxed text-cocoaSoft">
              {error}
            </p>
            <Button className="w-full" onClick={beginRecording}>
              再试一次
            </Button>
          </div>
        ) : phase === 'idle' ? (
          <div className="space-y-4 text-center">
            <button
              onClick={beginRecording}
              className="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-blush text-4xl text-white shadow-card transition hover:bg-rosy active:scale-95"
              aria-label="开始录音"
            >
              🎙️
            </button>
            <p className="text-sm text-cocoaSoft">点一下开始录音，最多 {MAX_SECONDS} 秒</p>
          </div>
        ) : phase === 'recording' ? (
          <div className="space-y-4 text-center">
            <div className="flex h-12 items-end justify-center gap-1.5">
              {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                <div
                  key={i}
                  className="w-2 animate-pulse rounded-full bg-rosy"
                  style={{
                    height: `${30 + ((i * 53) % 70)}%`,
                    animationDelay: `${i * 120}ms`,
                    animationDuration: '600ms',
                  }}
                />
              ))}
            </div>
            <p className="font-display text-3xl text-cocoa">{fmtClock(elapsed)}</p>
            <p className="text-xs text-cocoaSoft/70">正在录音…到 {MAX_SECONDS} 秒自动停止</p>
            <div className="flex gap-2">
              <Button variant="soft" className="flex-1" onClick={cancelRecording} disabled={stopping}>
                取消
              </Button>
              <Button className="flex-1" onClick={stopRecording} disabled={stopping}>
                {stopping ? '处理中…' : '✔ 录好了'}
              </Button>
            </div>
          </div>
        ) : result ? (
          <div className="space-y-4">
            <p className="text-xs font-bold text-cocoaSoft">试听一下</p>
            <div className="rounded-2xl bg-cream px-3 py-3">
              <VoiceNote src={result.url} seconds={result.seconds} />
            </div>
            {sendError ? (
              <p className="rounded-xl bg-peach/40 px-3 py-2 text-center text-xs font-bold text-rosy">{sendError}</p>
            ) : null}
            <div className="flex gap-2">
              <Button variant="soft" className="flex-1" onClick={reRecord} disabled={sending}>
                重录
              </Button>
              <Button className="flex-1" onClick={send} disabled={sending}>
                {sending ? '发送中…' : '发出去'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-cocoaSoft">正在启动麦克风…</div>
        )}
      </div>
    </Modal>
  )
}
