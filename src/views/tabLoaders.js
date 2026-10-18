/**
 * 页签分包入口。只有这一处知道「哪个页签对应哪个动态 import」——
 * Dashboard 用它生成 lazy 组件，tabPrefetch.js 用它做预加载，
 * 两边永远不可能跑偏（以前是两处各自写一份 import 字符串）。
 *
 * 别在这里加静态 import：写了就失去分包的意义，全被打回首屏。
 */
export const TAB_LOADERS = {
  diary: () => import('./Diary.jsx'),
  photos: () => import('./Photos.jsx'),
  peace: () => import('./Peace.jsx'),
  messages: () => import('./Messages.jsx'),
  period: () => import('./Period.jsx'),
}
