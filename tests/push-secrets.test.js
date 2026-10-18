/**
 * 推送密钥：不许再回到仓库里
 *
 * 之前的做法是把三个密钥直接写在源码里（Edge Function 的 PUSH_SECRET / VAPID 私钥，
 * 以及数据库触发函数里的 x-push-secret）。仓库或部署包一旦被外人看到，就等于：
 *   · 拿到共享密钥 → 可以自己构造请求，让云函数给对方推任意内容；
 *   · 拿到 VAPID 私钥 → 可以冒充本站给已订阅用户推消息。
 *
 * 现在的要求（这几条用例就是护栏）：
 *   1. Edge Function 只从部署环境变量读密钥，源码里不许出现字面量；
 *   2. 数据库侧的密钥从 Vault 读（038），且必须先用 to_regclass 探测存在性；
 *   3. 前端只留**公钥**（公钥本来就要发给浏览器，但私钥绝不能出现）；
 *   4. 已轮换掉的旧值一旦回来，立刻报警。
 *   5. ⚠ push_secret() 返回的是**明文共享密钥**，任何客户端角色（anon / authenticated /
 *      PUBLIC）都不许有执行权 —— 否则登录用户直接 /rpc/push_secret 就能拿到它，
 *      再自己构造请求让 push-send 给任意订阅者推任意内容。
 *      触发器靠 security definer 以函数所有者身份调用，不需要任何 grant。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(process.cwd())

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.workbuddy',
  'generated-images',
  'media-api',
])

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(js|jsx|ts|tsx|mjs|sql|json|md)$/.test(name)) out.push(full)
  }
  return out
}

const files = walk(root)
const read = (p) => fs.readFileSync(p, 'utf8')

const MIGRATIONS_DIR = path.join(root, 'supabase/migrations')
const migrationFiles = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()

// 剥掉整行 `--` 注释：把 grant 注释掉不该能绕过护栏（migrations-layout 那条也是这么做的）
const stripComments = (sql) =>
  sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')

/**
 * 取出所有「针对 push_secret() 的 grant / revoke 语句」，并解析出它的目标角色。
 * 目标角色只看 `to` / `from` 后面的部分 —— 否则 `public.push_secret()` 里的
 * 模式名 public 会被误当成角色 PUBLIC，把漏洞判成「已撤销」。
 */
function secretPrivStatements(sql) {
  return stripComments(sql)
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => /\b(grant|revoke)\b/i.test(s) && /\bfunction\b/i.test(s) && /push_secret/i.test(s))
    .map((s) => {
      const m = s.match(/\b(?:from|to)\s+([^;]+)$/i)
      const roles = m ? m[1].split(',').map((r) => r.trim().toLowerCase()) : []
      return { kind: /^grant\b/i.test(s) ? 'grant' : 'revoke', roles, raw: s }
    })
}

const CLIENT_ROLES = ['anon', 'authenticated', 'public']

// 2026-10-17 轮换掉的旧值：出现即视为密钥回流
const DEAD_VALUES = [
  'a8682cff87a9a282684fe7f294646de075d03730814965ee', // 旧 x-push-secret
  'Ul50lc97t2SJRXB7VNThX9g7Fuu8viTf9ubPQeTR_KM', // 旧 VAPID 私钥
]

describe('推送密钥不再硬编码', () => {
  it('已轮换的旧密钥不出现在任何源文件里', () => {
    const hits = []
    for (const f of files) {
      // 本文件自己就写着「要抓的旧值」，跳过自己
      if (f.endsWith('push-secrets.test.js')) continue
      const text = read(f)
      for (const v of DEAD_VALUES) if (text.includes(v)) hits.push(`${path.relative(root, f)} 含旧密钥`)
    }
    expect(hits).toEqual([])
  })

  it('Edge Function 的三个密钥都从环境变量读，源码里没有字面量', () => {
    const src = read(path.join(root, 'supabase/functions/push-send/index.ts'))
    for (const name of ['PUSH_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) {
      expect(src).toContain(`Deno.env.get('${name}')`)
    }
    // 形如 const PUSH_SECRET = 'xxxx' 的字面量赋值必须绝迹
    expect(src).not.toMatch(/const\s+(PUSH_SECRET|VAPID_PUBLIC|VAPID_PRIVATE)\s*=\s*'[^']{8,}'/)
    // 配不齐要明确报 500，不能静默用错密钥
    expect(src).toContain('缺少环境变量')
  })

  it('数据库侧密钥从 Vault 读，且先探测 vault 是否存在（防 42P01）', () => {
    const sql = read(path.join(root, 'supabase/migrations/038_push_secrets.sql'))
    expect(sql).toContain('to_regclass(\'vault.decrypted_secrets\')')
    expect(sql).toContain('push_secret')
    expect(sql).toMatch(/create or replace function public\.fn_push_notify\(\)/)
    // 触发函数里不能再出现密钥字面量
    expect(sql).not.toMatch(/x-push-secret['"]?\s*,\s*'[A-Za-z0-9]{16,}'/)
  })

  it('026 里的旧密钥已清空，并指向 038', () => {
    const sql = read(path.join(root, 'supabase/migrations/026_push.sql'))
    expect(sql).not.toContain(DEAD_VALUES[0])
    expect(sql).toContain('038_push_secrets.sql')
    // ⚠ 026 跑在 038 之前，不能直接在里面调 push_secret()（那时函数还不存在，
    //    会让所有 INSERT 整体失败）→ 只能是空字符串
    expect(sql).not.toContain('public.push_secret()')
  })

  // ⚠ 这条是全组最关键的一条：push_secret() 返回明文共享密钥，
  //   任何客户端角色拿到执行权 = 拿到密钥本身。
  it('任何迁移都不把 push_secret() 授权给客户端角色（anon / authenticated / PUBLIC）', () => {
    const bad = []
    for (const f of migrationFiles) {
      for (const s of secretPrivStatements(read(path.join(MIGRATIONS_DIR, f)))) {
        if (s.kind !== 'grant') continue
        for (const role of s.roles) {
          if (CLIENT_ROLES.includes(role)) bad.push(`${f} → ${s.raw}`)
        }
      }
    }
    // 反向验证：把 `grant execute on function public.push_secret() to authenticated`
    // 写回 038，这条用例会点名报错。
    expect(bad).toEqual([])
  })

  it('038 显式撤销了 anon 与 authenticated 的执行权（只留函数所有者）', () => {
    const sql = read(path.join(MIGRATIONS_DIR, '038_push_secrets.sql'))
    const revoked = new Set()
    for (const s of secretPrivStatements(sql)) {
      if (s.kind === 'revoke') for (const role of s.roles) revoked.add(role)
    }
    // PUBLIC 必须撤（新建函数的默认权限就是给 PUBLIC，anon 也在里面）
    expect([...revoked].sort()).toEqual(['anon', 'authenticated', 'public'])
  })

  it('触发函数靠 security definer 调用密钥函数，不依赖客户端授权', () => {
    const sql = read(path.join(MIGRATIONS_DIR, '038_push_secrets.sql'))
    const fn = sql.slice(sql.indexOf('create or replace function public.fn_push_notify()'))
    expect(fn).toMatch(/security\s+definer/i)
    expect(fn).toContain('public.push_secret()')
  })

  it('前端只留 VAPID 公钥，不含任何私钥', async () => {
    const src = read(path.join(root, 'src/lib/push.js'))
    expect(src).toMatch(/const VAPID_PUBLIC_KEY = 'B[A-Za-z0-9_-]{86}'/) // P-256 未压缩点，base64url 87 字符
    expect(src).not.toMatch(/VAPID_PRIVATE|privateKey|PRIVATE_KEY/)
  })
})
