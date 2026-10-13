// 性别主题：按当前用户的 gender 给 <html> 挂 theme-male（男生蓝调），
// 配合 index.css 的 CSS 变量与 tailwind.config.js 的变量化主色生效。
// 女生 / 未设置 → 默认粉调（不挂 class）。

export function applyGenderTheme(gender) {
  if (typeof document === 'undefined') return
  try {
    document.documentElement.classList.toggle('theme-male', gender === 'male')
  } catch {
    /* 忽略 */
  }
}

/** 弹窗关闭/组件卸载时还原为某个用户的主题（编辑资料预览用） */
export function resetGenderTheme(gender) {
  applyGenderTheme(gender)
}
