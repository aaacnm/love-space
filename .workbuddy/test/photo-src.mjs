// 照片墙的源码扫描基线：Photos.jsx 已拆成 src/views/photos/ 下的多个模块，
// 扫描必须覆盖整个目录，否则每次拆分都会误报「功能消失」。
// 用法：const src = photoSrc(); /pattern/.test(src)
import { readdirSync, readFileSync } from 'node:fs'

const ROOT = 'D:/love/'

export function photoSrc() {
  const files = ['src/views/Photos.jsx']
  try {
    for (const f of readdirSync(ROOT + 'src/views/photos')) {
      if (/\.jsx?$/.test(f)) files.push('src/views/photos/' + f)
    }
  } catch {
    /* 目录不存在时只扫主文件 */
  }
  return files
    .map((f) => {
      try {
        return readFileSync(ROOT + f, 'utf8')
      } catch {
        return ''
      }
    })
    .join('\n')
}

// 单个文件的源码（需要精确定位某个函数体时用）
export function readSrc(rel) {
  return readFileSync(ROOT + rel, 'utf8')
}
