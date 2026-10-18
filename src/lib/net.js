// 网络状况判断：后台任务要不要干，都得先过这一关。
//
// 后台任务（页签分包预热、旧照片缩略图补齐）的共同点是：**用户没有要求做**。
// 它们做得早一点晚一点用户都感觉不到，但和用户正在加载的图片、正在拉的数据抢带宽，
// 用户立刻就感觉得到。所以统一按同一把尺子判断：
//
//   saveData   → 用户明确要求省流，一律不做
//   2g/slow-2g → 带宽本来就只够 uploading 文本，一律不做
//   3g         → 常见于信号一般的 LTE（RTT 偏高但能用），照做；
//                一刀切禁掉会让一半移动端用户永远拿不到预热
//   拿不到 NetworkInformation → 保守放行（没法判断就别替用户做决定）
export function networkCheap() {
  if (typeof navigator === 'undefined') return true
  const c = navigator.connection || navigator.webkitConnection || navigator.mozConnection
  if (!c) return true
  if (c.saveData) return false
  const type = String(c.effectiveType || '').toLowerCase()
  return type !== '2g' && type !== 'slow-2g'
}
