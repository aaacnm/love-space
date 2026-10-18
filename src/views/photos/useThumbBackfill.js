// 旧照片批量补缩略图：024 之前上传的照片 thumb_path 是 null。
// 浏览时它们走「服务端 480 变换」兜底（能看、也省流量），但每次都要多一次变换端点请求。
// 这里后台静默补一份真实缩略图文件、写回 thumb_path，补完就转入批量签名通道。
//
// 刻意做成静默的：补齐只是优化，失败不该打扰用户（网格照样能用变换兜底显示）。
// 一个空间一次会话最多补一轮，且一轮最多 LIMIT 张 —— 补不动的不会无限重试。
//
// ⚠ 什么时候补：每张都要「下载 480 → 上传新文件 → 改数据库」三段网络操作，
// 而用户此刻正在翻照片墙 —— 这活儿必须给正在加载的缩略图让路。所以：
//   1) 等首屏画完、主线程空下来才开工（whenIdle，老浏览器 1.2s 兜底）；
//   2) 省流 / 2g / slow-2g 直接本轮不补（且不记账，下次网好了还能补）；
//   3) 补的过程中网络变差 → 立刻停手（每条开始前重新过一遍门槛）。
import { useEffect, useRef } from 'react'
import { supabase } from '../../lib/supabase.js'
import { signedMediaUrl } from '../../lib/storage.js'
import { mapLimit } from '../../lib/image.js'
import { whenIdle } from '../../lib/idle.js'
import { networkCheap } from '../../lib/net.js'
import { THUMB_TF } from './constants.js'

const LIMIT = 20
const CONCURRENCY = 3
// 同一空间一次会话只补一轮（模块级：切走再切回来不重复跑）
const finished = new Set()
// ⚠ 排队/运行标记一律按 coupleId 记，不能用「布尔标记」：
//   照片页经常保持挂载、只换 coupleId（切换空间），布尔标记一旦被旧空间置上，
//   新空间就永远排不进补齐队列（scheduled 不重置 = 后台补齐在新空间静默失效）。
const runningIds = new Set()
// 全局串行：同一时刻只让一轮在动，两个空间一起跑会把带宽吃成两倍
let chain = Promise.resolve()

export function useThumbBackfill({ rows, coupleId, enabled = true, onDone }) {
  // 已经排过队的空间 id（不是「有没有排过」，是「排的是哪个空间」）
  const scheduledId = useRef(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    if (!enabled || !coupleId) return
    if (scheduledId.current === coupleId) return
    if (runningIds.has(coupleId) || finished.has(coupleId)) return
    const todo = (rows || []).filter((p) => !p.thumb_path && p.storage_path).slice(0, LIMIT)
    if (todo.length === 0) return
    // 省流/弱网：本轮放弃。刻意**不**写 finished —— 网好了下次进来还能补
    if (!networkCheap()) return

    const run = async () => {
      let patched = 0
      await mapLimit(todo, CONCURRENCY, async (p) => {
        if (!networkCheap()) return // 补到一半网络变差 → 立刻停手，别跟用户抢带宽
        try {
          const url = await signedMediaUrl('photos', p.storage_path, THUMB_TF)
          if (!url) return
          const res = await fetch(url)
          if (!res.ok) return
          const blob = await res.blob()
          if (!blob || blob.size === 0) return
          const ext = blob.type === 'image/png' ? 'png' : 'jpg'
          const path = `thumbs/${coupleId}/${crypto.randomUUID()}.${ext}`
          // 不走 uploadOne：它在失败时会 toast，补齐失败不该弹窗打扰
          const { error } = await supabase.storage.from('photos').upload(path, blob, {
            cacheControl: '31536000',
            contentType: blob.type || 'image/jpeg',
            upsert: false,
          })
          if (error) return
          const { error: upErr } = await supabase.from('photos').update({ thumb_path: path }).eq('id', p.id)
          if (upErr) return
          patched += 1
        } catch (e) {
          console.warn('[thumb-backfill] 补缩略图失败：', p.id, e?.message)
        }
      })
      if (patched > 0) doneRef.current?.()
    }

    // rows 每次分页都会换引用；靠 scheduledId / runningIds / finished 三道闸保证一个空间只排一轮。
    // 卸载得早（没轮到空闲就切走了）时不记账，下次进来还能重新排队。
    scheduledId.current = coupleId
    let started = false
    const start = () => {
      // ⚠ 一进来就置位，哪怕下面因为「这个空间已经在跑」直接返回：
      // 只要 idle 回调真的触发过，就不再把它当成「待取消的排队」。
      started = true
      if (runningIds.has(coupleId)) return
      runningIds.add(coupleId)
      finished.add(coupleId)
      // 旧空间那一轮还在跑时（最多 20 张，会自己跑完），新空间排在它后面而不是并行开跑
      chain = chain
        .catch(() => {})
        .then(run)
        .catch(() => {})
        .finally(() => {
          runningIds.delete(coupleId)
        })
    }
    const cancelIdle = whenIdle(start, { timeout: 8000, fallback: 1200 })
    return () => {
      cancelIdle()
      // 排队期间被清理（rows 又变了 / 切走了页签）：idle 回调压根没跑，
      // 标记却已经写上去了 —— 不把它清掉，下一次 effect 就永远排不进队列。
      // 已经开工的（started）不能清：runningIds / finished 正在替它去重。
      if (!started && scheduledId.current === coupleId) scheduledId.current = null
    }
  }, [rows, coupleId, enabled])
}

export { LIMIT as THUMB_BACKFILL_LIMIT, finished as thumbBackfillFinished, runningIds as thumbBackfillRunning }
