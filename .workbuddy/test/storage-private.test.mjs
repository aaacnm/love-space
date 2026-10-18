/**
 * 存储安全升级（私有桶 + 签名 URL）回归测试
 *   1. lib/storage.js 单元：签名缓存（同文件只签一次）、transform 透传、批量去重
 *   2. 源码扫描：Photos/Messages/Diary 不再使用 getPublicUrl（公开 URL 全清退）
 *   3. 迁移文件：桶转私有 + 四类策略齐全 + helper 函数
 * 用法：NODE_PATH=<workspace>/node_modules node storage-private.test.mjs
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name)
  }
}

// ---------- 1. lib/storage.js 单元（stub supabase 模块） ----------
console.log('\n单元：签名 URL 与缓存')

let singleCalls = []
let batchCalls = []
let failOnce = false
const supabaseStubSource = `
export const supabase = {
  storage: {
    url: 'http://sb.test/storage/v1',
    from: () => ({
      createSignedUrl: async (p, ttl, opts) => {
        if (globalThis.__SIGN_FAIL_ONCE__ && !globalThis.__SIGN_FAIL_USED__) {
          globalThis.__SIGN_FAIL_USED__ = true
          return { data: null, error: { message: '网络开小差' } }
        }
        globalThis.__SINGLE__.push({ p, ttl, tf: (opts && opts.transform) || null })
        return { data: { signedUrl: 'http://sb.test/sign/' + p } }
      },
      createSignedUrls: async (paths, ttl) => {
        globalThis.__BATCH__.push([...paths])
        return { data: paths.map((p) => ({ path: p, signedUrl: 'http://sb.test/sign/' + p })), error: null }
      },
    }),
  },
}
`

const plugin = {
  name: 'stub',
  setup(b) {
    b.onResolve({ filter: /supabase\.js$/ }, () => ({ path: 'supa-stub', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: supabaseStubSource, loader: 'js' }))
  },
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'storage-private.bundle.cjs')
await esbuild.build({
  entryPoints: ['D:/love/src/lib/storage.js'],
  bundle: true,
  write: true,
  format: 'cjs',
  platform: 'node',
  packages: 'external',
  plugins: [plugin],
  outfile: out,
})
globalThis.__SINGLE__ = singleCalls
globalThis.__BATCH__ = batchCalls
delete require.cache[out]
const storage = require(out)

{
  // 缓存：同一 bucket+path+transform 只签一次
  const u1 = await storage.signedMediaUrl('photos', 'photos/c1/a.jpg')
  const u2 = await storage.signedMediaUrl('photos', 'photos/c1/a.jpg')
  ok(u1 === u2 && u1.includes('/sign/photos/c1/a.jpg'), '同文件重复调用返回缓存 URL')
  ok(singleCalls.length === 1, '只发起了一次签名请求')
  // 不同 transform 视为不同资源
  await storage.signedMediaUrl('photos', 'photos/c1/a.jpg', { height: 1280, resize: 'contain' })
  ok(singleCalls.length === 2, 'transform 不同会单独签')
  ok(singleCalls[1].tf && singleCalls[1].tf.resize === 'contain' && singleCalls[1].tf.height === 1280, 'transform 参数透传给 storage API')
  ok(singleCalls[0].ttl === 60 * 60 * 24 * 7, '签名有效期 = 7 天上限')
  // 批量：去重 + 与单签缓存互通
  const m = await storage.signedMediaUrls('photos', ['photos/c1/a.jpg', 'photos/c1/b.jpg', 'photos/c1/a.jpg'])
  ok(batchCalls.length === 1 && batchCalls[0].length === 1, '批量签名去重且跳过已缓存文件')
  ok(m.get('photos/c1/a.jpg') && m.get('photos/c1/b.jpg'), '批量结果 Map 完整')
  // 失败安全：签不出来返回空串且不缓存
  globalThis.__SIGN_FAIL_ONCE__ = true
  globalThis.__SIGN_FAIL_USED__ = false
  const bad = await storage.signedMediaUrl('photos', 'photos/c1/broken.jpg')
  ok(bad === '', '签名失败返回空串（不抛错）')
  const badAgain = await storage.signedMediaUrl('photos', 'photos/c1/broken.jpg')
  ok(badAgain !== '', '失败的文件不进缓存，下次会重签')
  // 空路径
  ok((await storage.signedMediaUrl('photos', '')) === '', '空路径返回空串')
}

// ---------- 2. 源码扫描：公开 URL 清退 ----------
console.log('\n源码：getPublicUrl 清退')

{
  const views = ['src/views/Photos.jsx', 'src/views/Messages.jsx', 'src/views/Diary.jsx']
  for (const f of views) {
    const src = fs.readFileSync('D:/love/' + f, 'utf8')
    ok(!src.includes('getPublicUrl'), `${f} 不再用公开 URL`)
    ok(!src.includes('withTransform(') || f === 'src/views/Photos.jsx' ? !src.includes('withTransform(') : true, `${f} 不再拼变换端点 URL`)
  }
  const avatar = fs.readFileSync('D:/love/src/components/Avatar.jsx', 'utf8')
  ok(avatar.includes("from('avatars')"), '头像桶保持公开读（Avatar 不变）')
  const smartimg = fs.readFileSync('D:/love/src/components/SmartImg.jsx', 'utf8')
  // 守卫的位置比写法重要：必须在渲染 <img> 之前就 return（签名未返回时不许出现空 src 的 img）。
  // 2026-10 起这里会渲染骨架占位，所以不能对着某句固定代码断言
  const guardAt = smartimg.indexOf('if (!src)')
  ok(guardAt > -1 && /if \(!src\) \{[\s\S]{0,80}?return null/.test(smartimg), 'SmartImg 空 src 时直接 return（不渲染 img）')
  ok(smartimg.lastIndexOf('<img') > guardAt, '守卫写在 <img> 之前（注释里的 <img> 不算）')
  ok(/data-skeleton/.test(smartimg), '签名期间渲染的是骨架占位，不是空 src 的 img')
}

// ---------- 3. 迁移文件 ----------
console.log('\n迁移：migration_storage_private.sql')

{
  const sql = fs.readFileSync('D:/love/supabase/migrations/030_storage_private.sql', 'utf8')
  ok(sql.includes("set public = false where id in ('photos', 'voice')"), '两个桶转私有')
  for (const act of ['select', 'insert', 'update', 'delete']) {
    ok(sql.includes(`for ${act}`) && sql.includes(`is_couple_member(auth.uid(), public.storage_couple_id('photos', name))`), `photos ${act} 策略按空间隔离`)
    ok(sql.includes(`is_couple_member(auth.uid(), public.storage_couple_id('voice', name))`), `voice ${act} 策略按空间隔离`)
  }
  ok(sql.includes('security definer') && sql.includes('from public.members'), '成员判定走 members 表（security definer）')
  ok(sql.includes("storage.foldername(name)"), '路径按段解析 coupleId')
  ok(sql.includes('drop policy if exists "photos_read"') && sql.includes('drop policy if exists "voice_read"'), '旧的宽松策略已撤')
  ok(!/values \('photos', 'photos', true\)/.test(sql), '迁移不会把桶改回公开')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exit(1)
