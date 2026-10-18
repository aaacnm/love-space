/**
 * 字体不许走第三方 CDN
 *
 * 原来的坑：index.html 直接引 fonts.googleapis.com。国内这个域名不通，而
 * `<link rel="stylesheet">` 是**阻塞渲染**的 —— 首屏会一直等到 TCP 超时才画出东西；
 * 就算能通，那串 URL 还带着 ZCOOL KuaiLe（中文装饰字体，几 MB）+ 7 个字重。
 *
 * 守住：① 页面不引外部字体；② 自托管字体带 font-display: swap；③ 中文字体不自托管（改走系统字体）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// 沙箱里 new URL(...) 读取会被拦，统一用 cwd 相对路径
const root = process.cwd()
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

// 注释里为了解释「为什么改」必然会提到这些域名/字体名，断言只看真实声明
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '')
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

describe('index.html 不引外部字体', () => {
  const html = stripHtmlComments(read('index.html'))

  it('没有任何 googleapis / gstatic 链接', () => {
    expect(html).not.toMatch(/fonts\.googleapis\.com/)
    expect(html).not.toMatch(/fonts\.gstatic\.com/)
  })

  it('没有外部 preconnect（外部字体没了就不该再握手）', () => {
    expect(html).not.toMatch(/preconnect/)
  })

  it('没有指向外站的阻塞样式表', () => {
    const links = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map((m) => m[0])
    expect(links.filter((l) => /https?:\/\//.test(l))).toEqual([])
  })
})

describe('自托管字体', () => {
  const css = stripCssComments(read('src/index.css'))

  it('@font-face 用的是仓库内文件，不是外链', () => {
    const face = /@font-face\s*\{[\s\S]*?\}/.exec(css)?.[0] || ''
    expect(face).toMatch(/url\(['"]\.\/assets\/fonts\//)
    expect(face).not.toMatch(/https?:\/\//)
  })

  it('字体文件真的在仓库里，且是合法的 woff2', () => {
    const file = path.join(root, 'src/assets/fonts/baloo2-latin-var.woff2')
    expect(fs.existsSync(file)).toBe(true)
    const head = Buffer.alloc(4)
    const fd = fs.openSync(file, 'r')
    fs.readSync(fd, head, 0, 4, 0)
    fs.closeSync(fd)
    expect(head.toString('latin1')).toBe('wOF2')
  })

  it('font-display: swap（先用系统字体画出来，字体到了再换，绝不阻塞首屏）', () => {
    expect(css).toMatch(/font-display:\s*swap/)
  })

  it('限死 unicode-range：中文不触发字体下载', () => {
    const face = /@font-face\s*\{[\s\S]*?\}/.exec(css)?.[0] || ''
    expect(face).toMatch(/unicode-range:/)
    expect(face).toMatch(/U\+0000-00FF/)
  })

  it('可变字体一个文件覆盖全部字重，不再按字重拆成多份', () => {
    const faces = css.match(/@font-face/g) || []
    expect(faces.length).toBe(1)
    expect(css).toMatch(/font-weight:\s*400 800/)
  })
})

describe('字体栈里不再有外链字体名', () => {
  const tw = stripCssComments(read('tailwind.config.js'))
  const css = stripCssComments(read('src/index.css'))

  it('不再引用 ZCOOL KuaiLe / Nunito 这些必须联网下载的字体', () => {
    for (const name of ['ZCOOL KuaiLe', 'Nunito']) {
      expect(tw).not.toContain(name)
      expect(css).not.toContain(name)
    }
  })

  it('display 字体名与 @font-face 里的 family 同名', () => {
    const family = /font-family:\s*'([^']+)'/.exec(css)?.[1]
    expect(family).toBe('Baloo 2')
    expect(tw).toContain('"Baloo 2"')
  })

  it('正文栈以系统字体开头（零网络等待）', () => {
    expect(css).toMatch(/font-family:\s*[\s\S]{0,80}system-ui/)
  })
})
