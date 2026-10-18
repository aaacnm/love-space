/**
 * 页签分包的预加载策略。
 *
 * 以前的做法是「空闲时把 5 个页签的分包一次全拉下来」：高速网络下点什么都零等待，
 * 但手机弱网/省流时，那 5 个 JS 请求会跟首屏数据、缩略图、签名 URL 抢带宽，
 * 反而把首屏拖慢。现在的规则是：
 *
 *   1) **有明确用户意图（按下页签）→ 立刻加载，不看网络状况。**
 *      这个请求反正要发（点了就要渲染），只是提前了几十毫秒，不算额外开销。
 *   2) **没有意图的后台预热 → 先看网络**：saveData 或 2g/slow-2g 就干脆不预热。
 *   3) 允许预热时也**只预热一个** —— 按「历史点击次数」挑最可能点的那个，
 *      而不是拍脑袋定优先级（每对情侣的用法不一样，写死的排序只对一半人有效）。
 *   4) 已经加载过的、正在加载中的都不会重复请求；失败留到下次重试，
 *      并且**预加载失败绝不冒泡**（它是优化，不是功能）。
 */
import { TAB_LOADERS } from './tabLoaders.js'

const HITS_KEY = 'love.tab.hits.v1'

const loaded = new Set()
const pending = new Set()

// ---------- 历史点击：预测「下一个最可能点的页签」 ----------

const readHits = () => {
  try {
    const raw = localStorage.getItem(HITS_KEY)
    return raw ? JSON.parse(raw) || {} : {}
  } catch {
    return {} // 隐私模式下 localStorage 可能不可写，降级成「无历史」
  }
}
const writeHits = (hits) => {
  try {
    localStorage.setItem(HITS_KEY, JSON.stringify(hits))
  } catch {
    /* 写不进去就算了 */
  }
}

/** 记一次页签浏览（含被保持挂载后的再次点击） */
export function recordTabHit(key) {
  if (!key) return
  const hits = readHits()
  const seq = (hits.__seq || 0) + 1
  const prev = hits[key] || { count: 0, last: 0 }
  hits[key] = { count: prev.count + 1, last: seq }
  hits.__seq = seq
  writeHits(hits)
}

/** 最可能被点的页签：次数优先，同次数时取最近点过的；没有任何历史 → null */
export function mostLikelyTab() {
  const hits = readHits()
  let best = null
  let bestScore = 0
  for (const key of Object.keys(TAB_LOADERS)) {
    const hit = hits[key]
    if (!hit || !hit.count) continue
    const score = hit.count * 1e6 + (hit.last || 0)
    if (score > bestScore) {
      bestScore = score
      best = key
    }
  }
  return best
}

export function clearTabHits() {
  try {
    localStorage.removeItem(HITS_KEY)
  } catch {
    /* ignore */
  }
}

// 网络门槛的实现挪到了 lib/net.js（后台任务共用同一把尺子），这里按原路径转出，
// 免得 Dashboard 等调用方跟着改一堆 import
export { networkCheap } from '../lib/net.js'

// ---------- 加载 ----------

/** 页签已经挂载渲染过，其分包必然已加载，无需再预热 */
export function markLoaded(key) {
  if (TAB_LOADERS[key]) loaded.add(key)
}

/**
 * 加载某个页签的分包。幂等：已加载/正在加载都直接返回 false。
 * 返回 true 表示这一次真的发起了请求 —— 调用方据此决定是否还要继续排别的任务。
 */
export function prefetchTab(key) {
  const loader = TAB_LOADERS[key]
  if (!loader) return false // home 是首屏静态引入，没有分包
  if (loaded.has(key) || pending.has(key)) return false
  pending.add(key)
  // 套一层 Promise.resolve()：import 失败时有些环境是同步抛出（模块已标记为 errored），
  // 直接 loader().then() 会把异常同步炸出 prefetchTab —— 预加载绝不能炸调用方
  Promise.resolve()
    .then(loader)
    .then(
      () => {
        pending.delete(key)
        loaded.add(key)
      },
      () => {
        // 失败不做任何事：允许下次重试（比如部署期间 chunk 404），
        // 也绝不把 rejection 抛出去打断页面（预加载只是优化）
        pending.delete(key)
      },
    )
  return true
}

/** 已加载完成的分包（测试/调试用） */
export function loadedTabs() {
  return new Set(loaded)
}
