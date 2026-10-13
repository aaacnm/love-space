// 性别主题（男生蓝调 / 女生粉调）+ 邀请文案角色化 冒烟测试
//   1. applyGenderTheme：male → html.theme-male；female/null → 移除
//   2. Home 邀请文案：男生「发给女朋友…她」、女生「发给男朋友…他」、未设置中性
//   3. 编辑资料弹窗：点选性别即时预览主题，关闭弹窗还原
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
const failures = []
const ok = (cond, name) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    failures.push(name)
    console.log('  ✗', name)
  }
}

// ---------- jsdom ----------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const { window } = dom
for (const k of ['window', 'document', 'localStorage', 'CustomEvent', 'Event', 'Node', 'HTMLElement', 'location', 'getComputedStyle', 'MutationObserver', 'URL', 'File', 'Blob']) {
  if (window[k] !== undefined) globalThis[k] = window[k]
}
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.HTMLInputElement = window.HTMLInputElement
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0)

const alerts = []
window.alert = (msg) => alerts.push(String(msg))
window.HTMLMediaElement.prototype.load = function () {}
window.HTMLMediaElement.prototype.play = function () {
  return Promise.resolve()
}
window.HTMLMediaElement.prototype.pause = function () {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tick = (ms = 30) => sleep(ms)

// ---------- esbuild 打包 ----------
const here = path.dirname(fileURLToPath(import.meta.url))
const React = require('react')
const ReactDOM = require('react-dom/client')

// 返回整个 cjs 模块 exports（esbuild 打包的 ESM 源码：命名导出在顶层，default 组件用 .default 取）
async function bundle(entry, outfile, extraPlugins = []) {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    jsx: 'automatic',
    platform: 'node',
    packages: 'external',
    outfile,
    plugins: extraPlugins,
    define: { 'import.meta.env': '{}' },
    logLevel: 'silent',
  })
  return require(outfile)
}

function mount(Component, props) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOM.createRoot(host)
  root.render(React.createElement(Component, props))
  return {
    async unmount() {
      root.unmount()
      host.remove()
      await tick(20)
    },
  }
}
const bodyText = () => document.body.textContent
const findBtn = (text) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent.includes(text) || (b.getAttribute('aria-label') || '').includes(text),
  )
const hasMaleTheme = () => document.documentElement.classList.contains('theme-male')

// ============================================================
console.log('\n场景组 1：applyGenderTheme 单元')
{
  const theme = await bundle('D:/love/src/lib/theme.js', path.join(here, 'theme-unit.bundle.cjs'))
  ok(!hasMaleTheme(), '初始无男生主题')
  theme.applyGenderTheme('male')
  ok(hasMaleTheme(), "male → 挂 theme-male")
  theme.applyGenderTheme('female')
  ok(!hasMaleTheme(), "female → 移除 theme-male（默认粉调）")
  theme.applyGenderTheme(null)
  ok(!hasMaleTheme(), 'null（未设置）→ 默认粉调')
}

// ---------- store stub ----------
const storeStub = `
export function StoreProvider({ children }) { return children }
export function useStore() { return globalThis.__STORE__ }
`

// ============================================================
console.log('\n场景组 2：Home 邀请文案按性别角色化')
{
  const Home = (
    await bundle('D:/love/src/views/Home.jsx', path.join(here, 'home-theme.bundle.cjs'), [
      {
        name: 'stubs',
        setup(b) {
          b.onResolve({ filter: /store\.jsx$/ }, () => ({ path: 'store-stub', namespace: 'stub' }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: storeStub, loader: 'js' }))
        },
      },
    ])
  ).default

  const baseStore = {
    couple: { id: 'c1', code: 'LOVE01' },
    members: [],
    milestones: [],
    partner: null,
    refresh: async () => {},
  }

  // 2a. 男生
  globalThis.__STORE__ = { ...baseStore, myMember: { id: 'u1', nickname: '阿强', gender: 'male' } }
  let h = await mount(Home, {})
  await tick(40)
  ok(bodyText().includes('发给女朋友') && bodyText().includes('邀请她'), '男生：邀请文案指向女朋友（她）')
  await h.unmount()

  // 2b. 女生
  globalThis.__STORE__ = { ...baseStore, myMember: { id: 'u1', nickname: '小美', gender: 'female' } }
  h = await mount(Home, {})
  await tick(40)
  ok(bodyText().includes('发给男朋友') && bodyText().includes('邀请他'), '女生：邀请文案指向男朋友（他）')
  ok(!hasMaleTheme(), 'Home 不负责主题切换（默认粉调）')
  await h.unmount()

  // 2c. 未设置性别 → 中性文案
  globalThis.__STORE__ = { ...baseStore, myMember: { id: 'u1', nickname: '小美', gender: null } }
  h = await mount(Home, {})
  await tick(40)
  ok(bodyText().includes('发给 TA 加入这个空间'), '未设置性别：中性文案')
  await h.unmount()
}

// ============================================================
console.log('\n场景组 3：编辑资料弹窗性别即时预览')
{
  const Modal = (
    await bundle('D:/love/src/components/EditProfileModal.jsx', path.join(here, 'edit-profile-theme.bundle.cjs'), [
      {
        name: 'stubs',
        setup(b) {
          b.onResolve({ filter: /store\.jsx$/ }, () => ({ path: 'store-stub', namespace: 'stub' }))
          b.onResolve({ filter: /supabase\.js$/ }, () => ({ path: 'supa-stub', namespace: 'stub' }))
          b.onResolve({ filter: /couple\.js$/ }, () => ({ path: 'couple-stub', namespace: 'stub' }))
          b.onResolve({ filter: /hooks\.js$/ }, () => ({ path: 'hooks-stub', namespace: 'stub' }))
          b.onLoad(
            { filter: /.*/, namespace: 'stub' },
            (args) => ({
              contents:
                args.path === 'store-stub'
                  ? storeStub
                  : args.path === 'supa-stub'
                    ? 'export const supabase = globalThis.__SUPA__'
                    : args.path === 'couple-stub'
                      ? 'export async function updateMyProfile() { return { error: null } }'
                      : 'export const AVATAR_EMOJIS = ["💕","😘"]',
              loader: 'js',
            }),
          )
        },
      },
    ])
  ).default

  globalThis.__SUPA__ = {
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: 'http://x/a.jpg' } }) }) },
  }
  // 当前资料：女生
  globalThis.__STORE__ = {
    myMember: { id: 'u1', nickname: '小美', gender: 'female' },
    refresh: async () => {},
  }

  let h = await mount(Modal, { open: true, onClose: () => {} })
  await tick(60)
  ok(!hasMaleTheme(), '打开时（女生资料）保持粉调')
  findBtn('♂ 男生').click()
  await tick(60)
  ok(hasMaleTheme(), '点选「♂ 男生」即时预览蓝调主题')
  findBtn('♀ 女生').click()
  await tick(60)
  ok(!hasMaleTheme(), '换选「♀ 女生」回到粉调')
  // 关闭弹窗（open=false）还原为资料值
  h = await mount(Modal, { open: false, onClose: () => {} })
  await tick(40)
  ok(!hasMaleTheme(), '关闭弹窗还原为资料主题（女生）')
  await h.unmount()
  await (async () => {})()
  // 第一个实例的 cleanup 在 unmount 后生效
  await tick(30)
}

// ============================================================
console.log(`\n结果: ${pass} 通过, ${failures.length} 失败`)
if (failures.length) {
  console.log('失败项:')
  failures.forEach((f) => console.log('  ✗', f))
  process.exit(1)
}
process.exit(0)
