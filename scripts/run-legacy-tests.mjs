/**
 * 跑 .workbuddy/test 下的历史 jsdom 冒烟测试（esbuild + jsdom 自制 harness）。
 *
 * 这些用例早于 Vitest 建立，覆盖录音、头像裁剪、附件、主题等一批链路，
 * 仍有回归价值，所以保留并通过 `npm run test:legacy` 一键跑完。
 * 它们依赖 jsdom / esbuild（项目 devDependencies 已含），无需额外环境。
 *
 * 用法：npm run test:legacy [-- 只跑某个关键字]
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, '.workbuddy', 'test')
const filter = process.argv[2] || ''

if (!fs.existsSync(dir)) {
  console.log('没有 .workbuddy/test 目录（历史用例不在本仓库内），跳过。')
  process.exit(0)
}

const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !filter || f.includes(filter))
  .sort()

if (files.length === 0) {
  console.log('没有匹配的历史用例。')
  process.exit(0)
}

// 老脚本用 require('jsdom')：优先用项目 node_modules，没有再退回 Workspace 目录
const legacyNodePath = [path.join(root, 'node_modules'), process.env.LEGACY_NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)

let passed = 0
const failed = []
const t0 = Date.now()

for (const f of files) {
  const started = Date.now()
  const r = spawnSync(process.execPath, [path.join(dir, f)], {
    cwd: dir,
    env: { ...process.env, NODE_PATH: legacyNodePath },
    encoding: 'utf-8',
  })
  const ok = r.status === 0
  const ms = Date.now() - started
  if (ok) {
    passed++
    console.log(`  ✓ ${f} (${ms}ms)`)
  } else {
    failed.push(f)
    console.log(`  ✗ ${f} (${ms}ms)`)
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')
    out.slice(-25).forEach((line) => console.log(`      ${line}`))
    // 子进程压根没起来时 stdout/stderr 都是空的（受限环境里 spawn 会被拒），
    // 不打印 r.error 就只能看到「全灭」却不知道原因
    if (r.error) console.log(`      spawn 失败：${r.error.message}（status=${r.status} signal=${r.signal}）`)
  }
}

console.log(`\n历史用例：${passed} 通过 / ${failed.length} 失败（共 ${files.length}，${Date.now() - t0}ms）`)
if (failed.length > 0) {
  console.log('失败文件：' + failed.join(', '))
  process.exit(1)
}
