/**
 * 迁移目录 → 生成物同步器（单一事实来源：supabase/migrations/*.sql）
 *
 *   node scripts/sync-migrations.mjs          重新生成 schema.sql 快照 + check_migration_status.sql
 *   node scripts/sync-migrations.mjs --check  只校验是否已同步（给 CI 用，不同步就 exit 1）
 *
 * 为什么需要它：以前 schema.sql 靠手抄最新的迁移，时间一长必然漂移
 * （本次整理时就发现它漏了 4 张迁移已经建好的表）。现在 schema.sql 完全由
 * migrations/ 生成，任何人都能一眼确认「库的最新结构是什么」。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = path.join(root, 'supabase', 'migrations')
const snapshotPath = path.join(root, 'supabase', 'schema.sql')
const checkPath = path.join(root, 'supabase', 'check_migration_status.sql')

const NAME_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/

function fail(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

/** 读取并按版本号升序排列全部迁移 */
function readMigrations() {
  if (!fs.existsSync(migrationsDir)) fail(`找不到 ${migrationsDir}`)
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  const list = files.map((file) => {
    const m = NAME_RE.exec(file)
    if (!m) fail(`文件名不合规范（应形如 007_albums_photo_ref.sql）：${file}`)
    const text = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    const pick = (tag) => {
      const hit = new RegExp(`^--\\s*${tag}:\\s*(.+)$`, 'm').exec(text)
      return hit ? hit[1].trim() : null
    }
    const fingerprint = pick('fingerprint')
    const check = pick('check')
    if (!fingerprint) fail(`${file} 缺少 "-- fingerprint: <布尔 SQL>" 元信息`)
    if (!check) fail(`${file} 缺少 "-- check: <特征说明>" 元信息`)
    return {
      version: m[1],
      name: m[2],
      file,
      fingerprint,
      check,
      text: text.replace(/\r\n/g, '\n').trimEnd(),
    }
  })

  const numbers = list.map((x) => Number(x.version))
  const dup = numbers.find((n, i) => numbers.indexOf(n) !== i)
  if (dup != null) fail(`版本号重复：${dup}`)
  numbers.forEach((n, i) => {
    if (n !== i + 1) fail(`版本号必须从 001 连续递增，发现断层：期望 ${String(i + 1).padStart(3, '0')}，实际 ${String(n).padStart(3, '0')}`)
  })
  const names = new Set(list.map((x) => x.name))
  if (names.size !== list.length) fail('存在重名的迁移 slug')
  return list
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`

/** 生成「新环境一次性建库」快照 */
function buildSnapshot(list) {
  const head = [
    '-- ============================================================',
    '--  ⚠️ 自动生成文件，请勿手改 —— 由 migrations/ 目录生成',
    '--     重跑命令：npm run db:sync',
    '--',
    '--  本文件内容 = 按顺序执行 supabase/migrations/ 下全部迁移后的结果。',
    '--  用途：',
    '--    1) 新 Supabase 项目一次性建库（SQL Editor 全选粘贴执行）',
    '--    2) 想快速看清「最新库结构到底长什么样」',
    '--',
    '--  已上线环境不要直接跑这个文件！请用 `supabase db push`，或对照',
    '--  supabase/check_migration_status.sql 找出没跑过的编号逐个补。',
    '--  若一次执行多条 DDL 担心锁等待（40P01），改成按编号逐文件跑。',
    '-- ============================================================',
    '',
  ]
  const parts = list.map(
    (m) =>
      [
        `-- ------------------------------------------------------------`,
        `--  ${m.file} · ${m.check}`,
        `-- ------------------------------------------------------------`,
        '',
        m.text,
        '',
      ].join('\n'),
  )
  return [...head, ...parts].join('\n')
}

/** 生成「当前库跑到哪了」的自查脚本 */
function buildCheckScript(list) {
  const rows = list.map(
    (m) =>
      `  select ${q(m.version)}::text as version, ${q(m.file)}::text as file, ${q(m.check)}::text as expects,\n` +
      `         (${m.fingerprint}) as applied`,
  )
  const body = [
    '-- ============================================================',
    '--  数据库版本自查 —— 自动生成，请勿手改（npm run db:sync）',
    '--  用法：Supabase Dashboard → SQL Editor → 全选粘贴 → Run',
    '--  输出：每个迁移一行，applied = false 的就是还没跑过的。',
    '-- ============================================================',
    '',
    '-- ---------- 1. 逐迁移核对 ----------',
    'select v.version,',
    '       v.file,',
    '       v.expects,',
    '       case when v.applied then \'已执行\' else \'未执行 ← 需要补跑\' end as status',
    'from (',
    rows.join('\nunion all\n'),
    ') v',
    'order by v.version;',
    '',
    '-- ---------- 2. 汇总：还差几个 ----------',
    'select count(*) filter (where applied) as executed,',
    '       count(*) filter (where not applied) as pending',
    'from (',
    rows.join('\nunion all\n'),
    ') v;',
    '',
    '-- ---------- 3. CLI 视角：这个库有没有 Supabase CLI 的迁移记录 ----------',
    '--         · 「尚未启用」= 以前全是手工在 SQL Editor 跑的，CLI 不知道跑到哪了；',
    '--           想接入 CLI 就对已跑过的逐个 `supabase migration repair <版本号> --status applied`，',
    '--           版本号就是文件名前三位（001、002 …）。',
    '--         · 「CLI 已记录」= 这段会逐条列出已登记的版本，可以和上面的指纹结果对照：',
    '--           · CLI true / 指纹 false —— 登记了但结构对不上，需要排查',
    '--           · CLI false / 指纹 true —— 手工跑过忘登记，用 repair 补上即可',
    '--         结果印在「Messages」标签页（raise notice），不在结果表格里。',
    '--',
    '--         ⚠️ 不能写成 `select ... from supabase_migrations.schema_migrations`：',
    '--            没用 CLI 推过的库没有这个 schema，直接查会报 42P01relation does not exist，',
    '--            所以这里先用 to_regclass 探测（不存在返回 null，不报错）再动态执行。',
    'do $$',
    'declare',
    '  tbl regclass := to_regclass(\'supabase_migrations.schema_migrations\');',
    '  cnt int := 0;',
    '  rec record;',
    'begin',
    '  if tbl is null then',
    '    raise notice \'本库尚未启用 Supabase CLI 迁移记录（无 supabase_migrations.schema_migrations）——迁移都是手工跑的，跳过 CLI 对照。\';',
    '    return;',
    '  end if;',
    '  for rec in execute format(\'select version, name from %s order by version\', tbl) loop',
    '    cnt := cnt + 1;',
    '    raise notice \'CLI 已记录 % : %\', rec.version, coalesce(rec.name, \'-\');',
    '  end loop;',
    '  raise notice \'CLI 共登记 % 条已应用迁移\', cnt;',
    'end $$;',
    '',
  ].join('\n')
  return body
}

const list = readMigrations()
const snapshot = buildSnapshot(list)
const checkScript = buildCheckScript(list)
const checkOnly = process.argv.includes('--check')

const targets = [
  ['supabase/schema.sql', snapshotPath, snapshot],
  ['supabase/check_migration_status.sql', checkPath, checkScript],
]

/** 当前磁盘上的生成物是否与 migrations/ 一致（返回不一致的文件名列表） */
export function driftList() {
  return targets
    .filter(([, file, content]) => {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null
      return current !== content
    })
    .map(([label]) => label)
}
export { readMigrations, buildSnapshot, buildCheckScript, snapshotPath, checkPath }

// 被 import 时不要执行 CLI 逻辑（测试会复用上面的纯函数，避免起子进程）
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (!invokedDirectly) {
  // no-op：作为模块被引用
} else if (checkOnly) {
  const drift = driftList()
  for (const label of drift) console.error(`✗ ${label} 与 migrations/ 不同步，请跑 npm run db:sync`)
  if (drift.length > 0) fail('生成物已漂移')
  console.log(`✓ 迁移 ${list.length} 个，编号连续，生成物同步`)
  process.exit(0)
} else {
  for (const [, file, content] of targets) fs.writeFileSync(file, content, 'utf8')
  console.log(`✓ 已从 ${list.length} 个迁移重新生成：`)
  console.log(`   ${path.relative(root, snapshotPath)}  (一次性建库快照)`)
  console.log(`   ${path.relative(root, checkPath)}  (版本自查脚本)`)
}
