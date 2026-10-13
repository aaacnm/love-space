// EditProfileModal 性别设置冒烟测试
// 覆盖：未选态 → 选男保存 → 回填 → 切女 → 再点取消 → 清除后保存为 null
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const esbuild = require('esbuild')

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

// ---------- stub 源码 ----------
const supaStub = `
export const supabase = globalThis.__SUPA__
`
const storeStub = `
export function StoreProvider({ children }) { return children }
export function useStore() { return globalThis.__STORE__ }
`

// ---------- supabase stub ----------
const me = { id: 'u1' }
const memberRow = { id: 'm1', couple_id: 'c1', user_id: 'u1', nickname: '小明', emoji: '💕', gender: null }

const membersDb = [memberRow]
let lastUpdate = null

const chain = (table) => {
  const q = {
    update(payload) {
      q._payload = payload
      return q
    },
    eq(col, val) {
      q._eq = [col, val]
      lastUpdate = { table, payload: q._payload, eq: [col, val] }
      if (table === 'members') {
        const row = membersDb.find((r) => r[q._eq[0]] === q._eq[1])
        if (row) Object.assign(row, q._payload)
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
  return q
}

globalThis.__SUPA__ = {
  auth: { getUser: async () => ({ data: { user: me } }) },
  from: (t) => chain(t),
  storage: { from: () => ({ upload: async () => ({ error: 'should not upload' }), remove: async () => ({}) }) },
}
globalThis.__STORE__ = { myMember: memberRow, refresh: async () => {} }

// ---------- bundle ----------
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'profile-gender.bundle.cjs')
await esbuild.build({
  entryPoints: ['D:/love/src/components/EditProfileModal.jsx'],
  bundle: true,
  format: 'cjs',
  jsx: 'automatic',
  platform: 'node',
  packages: 'external', // react/react-dom 留给外层 require，避免双实例 hooks 报错
  outfile: out,
  plugins: [
    {
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /supabase\.js$/ }, () => ({ path: 'supa-stub', namespace: 'stub' }))
        b.onResolve({ filter: /store\.jsx$/ }, () => ({ path: 'store-stub', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: args.path === 'supa-stub' ? supaStub : storeStub,
          loader: 'js',
        }))
      },
    },
  ],
})

// ---------- jsdom ----------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const { window } = dom
for (const k of ['window', 'document', 'localStorage', 'CustomEvent', 'location', 'requestAnimationFrame', 'getComputedStyle', 'MutationObserver', 'URL']) {
  if (window[k] !== undefined) globalThis[k] = window[k]
}
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const React = require('react')
const ReactDOM = require('react-dom/client')
const EditProfileModal = require(out).default

const root = ReactDOM.createRoot(document.getElementById('root'))
root.render(React.createElement(EditProfileModal, { open: true, onClose: () => {} }))
await tick(80)

const bodyText = () => document.body.textContent
const findBtn = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(text))
const selected = (label) => {
  const b = findBtn(label)
  return b ? b.className.includes('text-white') : false // 选中态是实底白字
}

console.log('\n场景 A：打开弹窗，默认未选性别')
await waitFor(() => bodyText().includes('性别'), '弹窗渲染')
ok(!selected('男生') && !selected('女生'), '默认两个都不选中')

console.log('\n场景 B：选男生并保存')
findBtn('男生').click()
await tick(40)
ok(selected('男生') && !selected('女生'), '男生选中态')
findBtn('保存').click()
await tick(150)
ok(lastUpdate?.payload?.gender === 'male', '保存 payload gender=male')
ok(membersDb[0].gender === 'male', 'members 行已更新为 male')

console.log('\n场景 C：重新打开回填男生，切到女生')
globalThis.__STORE__ = { myMember: { ...memberRow, gender: 'male' }, refresh: async () => {} }
root.render(React.createElement(EditProfileModal, { open: false, onClose: () => {} }))
await tick(40)
root.render(React.createElement(EditProfileModal, { open: true, onClose: () => {} }))
await tick(80)
ok(selected('男生'), '重开回填男生选中')
findBtn('女生').click()
await tick(40)
ok(selected('女生') && !selected('男生'), '切换到女生')
findBtn('保存').click()
await tick(150)
ok(membersDb[0].gender === 'female', '保存为 female')

console.log('\n场景 D：再点一次取消选择，保存为 null（清除）')
findBtn('女生').click()
await tick(40)
ok(!selected('女生'), '再点一次取消选中')
findBtn('保存').click()
await tick(150)
ok(membersDb[0].gender === null, '清除后 gender=null')

console.log('\n场景 E：昵称为空时提示，不触发保存')
root.render(React.createElement(EditProfileModal, { open: false, onClose: () => {} }))
await tick(40)
root.render(React.createElement(EditProfileModal, { open: true, onClose: () => {} }))
await tick(80)
const input = [...document.querySelectorAll('input')].find((i) => i.value === memberRow.nickname || i.maxLength === 12)
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
setter.call(input, '')
input.dispatchEvent(new window.Event('input', { bubbles: true }))
await tick(40)
findBtn('保存').click()
await tick(120)
ok(bodyText().includes('先告诉我你的昵称'), '空昵称提示')
ok(lastUpdate?.payload?.nickname !== '', '未提交空资料')

function waitFor(fn, name, tries = 60) {
  return new Promise((resolve) => {
    const go = async (n) => {
      if (fn()) return resolve(true)
      if (n <= 0) {
        failures.push('waitFor: ' + name)
        console.log('  ✗ waitFor 超时:', name)
        return resolve(false)
      }
      await tick(25)
      go(n - 1)
    }
    go(tries)
  })
}

root.unmount()
await tick(30)

console.log(`\n========== 结果：${pass} 通过 / ${failures.length} 失败 ==========`)
if (failures.length) {
  console.log('失败项：')
  failures.forEach((f) => console.log(' -', f))
  process.exit(1)
}
