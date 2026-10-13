/**
 * 迁移目录的「结构性」守护测试（不连数据库）
 *
 * 守护的是这套约定本身，防止过几个月又回到「到底哪个才是最新的」的状态：
 *   - 文件名必须是 NNN_slug.sql，编号从 001 连续递增、不重复
 *   - 每个迁移都要有 fingerprint / check / 顺序要求 / 依赖 四行元信息
 *   - 依赖只能指向更早的版本（不能成环）
 *   - supabase/ 根下不能再散落 migration_*.sql（必须迁进 migrations/）
 *   - schema.sql 与 check_migration_status.sql 必须是 migrations/ 的生成物
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { driftList } from '../scripts/sync-migrations.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = path.join(root, 'supabase', 'migrations')

let migrations = []

beforeAll(() => {
  migrations = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const text = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      const meta = (tag) => {
        const hit = new RegExp(`^--\\s*${tag}：\\s*(.+)$`, 'm').exec(text)
        return hit ? hit[1].trim() : null
      }
      const pick = (tag) => {
        const hit = new RegExp(`^--\\s*${tag}:\\s*(.+)$`, 'm').exec(text)
        return hit ? hit[1].trim() : null
      }
      return { file, text, order: meta('顺序要求'), deps: meta('依赖迁移'), fingerprint: pick('fingerprint'), check: pick('check') }
    })
})

describe('supabase/migrations 目录', () => {
  it('文件名全部符合 NNN_slug.sql 规范', () => {
    expect(migrations.length).toBeGreaterThan(10)
    for (const m of migrations) {
      expect(m.file, `${m.file} 命名不规范`).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/)
    }
  })

  it('版本号从 001 连续递增，没有重复和断层', () => {
    const versions = migrations.map((m) => Number(m.file.slice(0, 3)))
    expect(new Set(versions).size).toBe(versions.length)
    versions.forEach((v, i) => expect(v).toBe(i + 1))
  })

  it('每个迁移都写清了「顺序要求 / 依赖迁移 / fingerprint / check」四件套', () => {
    for (const m of migrations) {
      expect(m.order, `${m.file} 缺顺序要求`).toBeTruthy()
      expect(m.deps, `${m.file} 缺依赖说明`).toBeTruthy()
      expect(m.fingerprint, `${m.file} 缺 fingerprint`).toBeTruthy()
      expect(m.check, `${m.file} 缺 check 说明`).toBeTruthy()
    }
  })

  it('依赖只能指向更早的迁移（不存在循环依赖）', () => {
    for (const m of migrations) {
      const self = Number(m.file.slice(0, 3))
      const refs = [...m.deps.matchAll(/(\d{3})/g)].map((x) => Number(x[1]))
      for (const r of refs) {
        expect(r, `${m.file} 依赖了不存在的迁移 ${r}`).toBeGreaterThan(0)
        expect(r, `${m.file} 依赖了自身或之后的迁移 ${r}`).toBeLessThan(self)
      }
    }
  })

  it('指纹 SQL 都是布尔子查询，且 version != "001" 的文件都能一眼看出改了什么', () => {
    for (const m of migrations) {
      expect(m.fingerprint.toUpperCase()).toMatch(/^(EXISTS|NOT EXISTS|\()/)
      expect(m.fingerprint).not.toContain(';')
    }
  })

  it('supabase/ 根目录下不再散落 migration_*.sql', () => {
    const stray = fs.readdirSync(path.join(root, 'supabase')).filter((f) => /^migration_.*\.sql$/.test(f))
    expect(stray).toEqual([])
  })
})

describe('生成物必须与 migrations/ 保持一致', () => {
  it('schema.sql 和 check_migration_status.sql 是最新的（跑 npm run db:sync 可重建）', () => {
    const drift = driftList()
    expect(drift, `以下生成物已漂移，请跑 npm run db:sync：${drift.join(', ')}`).toEqual([])
  })

  it('每个迁移的指纹都出现在 check_migration_status.sql 里', () => {
    const script = fs.readFileSync(path.join(root, 'supabase', 'check_migration_status.sql'), 'utf8')
    for (const m of migrations) {
      expect(script, `${m.file} 的指纹没被写进自查脚本`).toContain(m.fingerprint)
      expect(script).toContain(m.file)
    }
  })

  it('schema.sql 标注了「自动生成，请勿手改」', () => {
    const snap = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8')
    expect(snap).toMatch(/自动生成文件，请勿手改/)
    for (const m of migrations) expect(snap).toContain(m.file)
  })
})
