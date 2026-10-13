// withTransform URL 参数回归测试
// 背景：Supabase render 端点「只传 width」会输出拉伸图（宽=width、高=原高），
// 512² 方头像被拉成 96×512 细长条，object-cover 一裁就成了「保存后头像自动放大」。
// 修复后所有调用点必须带 height + resize。此测试锁死 URL 形状。
import { withTransform } from '../../src/lib/image.js'

let pass = 0
let fails = []
const ok = (cond, name) => {
  if (cond) pass++
  else fails.push(name)
}
const eq = (a, b, name) => ok(a === b, `${name}（得到: ${a}）`)

const RAW = 'https://example.supabase.co/storage/v1/object/public/avatars/abc.jpg'

// 1. 方形头像场景（Avatar.jsx）：必须 width+height+resize=cover
eq(
  withTransform(RAW, 96, 80, { height: 96, resize: 'cover' }),
  'https://example.supabase.co/storage/v1/render/image/public/avatars/abc.jpg?width=96&height=96&resize=cover&quality=80',
  'Avatar 方图参数',
)

// 2. 保比例大图场景（灯箱）：contain
eq(
  withTransform(RAW, 1280, 82, { height: 1280, resize: 'contain' }),
  'https://example.supabase.co/storage/v1/render/image/public/avatars/abc.jpg?width=1280&height=1280&resize=contain&quality=82',
  '灯箱 contain 参数',
)

// 3. 旧签名（不带 opts）仍可用，但只应出现在「接受拉伸」的场景
eq(
  withTransform(RAW, 480, 70),
  'https://example.supabase.co/storage/v1/render/image/public/avatars/abc.jpg?width=480&quality=70',
  '旧签名兼容',
)

// 4. 空值防御
ok(!withTransform('', 96), '空 URL 原样返回')
ok(!withTransform(null, 96), 'null 原样返回')

// 5. 路径替换只发生一次且保留桶内子路径
eq(
  withTransform('https://example.supabase.co/storage/v1/object/public/photos/photos/x.jpg', 96, 75, { height: 96, resize: 'cover' }),
  'https://example.supabase.co/storage/v1/render/image/public/photos/photos/x.jpg?width=96&height=96&resize=cover&quality=75',
  '子路径保留',
)

// 6. 源码层面：不再存在「只传 width」的 withTransform 调用点（防回归复发）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const bad = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (/\.(jsx|js)$/.test(name)) {
      readFileSync(p, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!line.includes('withTransform(')) return
          // 函数定义本身不算调用点（含转发 opts 的包装函数）
          if (/export function withTransform|const withTransform|=> withTransform\(photoUrl\(path\), width, quality, opts\)/.test(line)) return
          // 调用行必须带 resize（height 与 resize 总是一起传）
          if (!line.includes('resize:')) bad.push(`${p}:${i + 1}: ${line.trim()}`)
        })
    }
  }
}
walk(join(import.meta.dirname, '..', '..', 'src'))
ok(bad.length === 0, `所有调用点都带 height+resize（违规: ${bad.join(' | ') || '无'}）`)

console.log(`\n结果: ${pass} 通过, ${fails.length} 失败`)
if (fails.length) {
  console.log('失败项:')
  fails.forEach((f) => console.log('  ✗', f))
  process.exit(1)
}
