/**
 * 列表查询瘦身：字段清单 + 首屏分页 + 副表按当前页 id 过滤 + 索引迁移
 *
 * 以前：所有列表都 select('*')，首屏一页 30 条，评论/回应/隐藏记录整表拉。
 * 现在：
 *   1. useCollection / usePagedCollection / useLatestRow 按 lib/tableColumns.js 的
 *      清单取字段，不再 select('*')
 *   2. 首屏一页 PAGE_SIZE 条（18，原来是 30）
 *   3. 评论 / 回应 / 隐藏记录按「当前已加载的主表 id」过滤（in），
 *      id 太多撑爆 URL 时退化成 limit 兜底
 *   4. 035 迁移给 moods / pokes 等表补上按空间和日期的索引
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { render, renderHook, screen, waitFor, fireEvent } from '@testing-library/react'
import { resetSupabase, sbApi, stub } from './helpers/supabase-stub-module.js'
import { StoreProvider } from '../src/lib/store.jsx'
import { PAGE_SIZE, usePagedCollection } from '../src/lib/hooks.js'
import { LIST_COLUMNS, SCOPE_FALLBACK_LIMIT, SCOPE_ID_LIMIT, columnsOf, scopeFilter } from '../src/lib/tableColumns.js'
import { writeLocalSession } from './helpers/local-session.js'
import Messages from '../src/views/Messages.jsx'

const root = process.cwd()
const read = (p) => readFileSync(path.join(root, p), 'utf8')

const USER = { id: 'u1', is_anonymous: true }
const ME = { id: 'mb1', couple_id: 'c1', user_id: 'u1', nickname: '我', city: '上海', timezone: 'Asia/Shanghai' }
const TA = { id: 'mb2', couple_id: 'c1', user_id: 'u2', nickname: 'TA', city: '北京', timezone: 'Asia/Shanghai' }
const COUPLE = { id: 'c1', code: 'ABC234' }
const nowIso = () => new Date().toISOString()

const msg = (over = {}) => ({
  id: 'm1',
  couple_id: 'c1',
  author_user_id: 'u1',
  content: '今天也想你',
  created_at: nowIso(),
  ...over,
})

function seedSpace() {
  window.localStorage.setItem(
    'love.space.v1',
    JSON.stringify({
      v: 1,
      savedAt: Date.now(),
      userId: USER.id,
      user: USER,
      coupleId: COUPLE.id,
      couple: COUPLE,
      members: [ME, TA],
      milestones: [],
      derived: { anniversary: null, nextMeetup: null },
    }),
  )
  writeLocalSession(USER.id) // 本机会话确认后 store 才会认领这份空间缓存
}

function boot(extraDb = {}) {
  resetSupabase({
    db: {
      couples: [COUPLE],
      members: [ME, TA],
      messages: [msg()],
      ...extraDb,
    },
  })
  sbApi.setUser(USER)
  sbApi.onRpc('bootstrap_space', async () => ({
    data: { user: USER, couple: COUPLE, members: [ME, TA], milestones: [], anniversary: null, next_meetup: null },
    error: null,
  }))
}

const selectsOf = (table) => stub.log.select.filter((s) => s.table === table)

// ---------- 从迁移里解析「每张表真实有哪些列」 ----------
// 目的：字段清单写错列名（或写了表里压根没有的列，比如 period_settings.id）
// 会让 PostgREST 直接报 42703，整条查询失败 —— 必须能在测试里拦住
function realColumns() {
  const dir = path.join(root, 'supabase/migrations')
  const cols = {}
  const add = (t, c) => {
    cols[t] = cols[t] || new Set()
    cols[t].add(c)
  }
  const SKIP = new Set([
    'primary', 'unique', 'foreign', 'check', 'constraint', 'default', 'references',
    'not', 'null', 'on', 'using',
  ])
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(dir, f), 'utf8')
    for (const m of sql.matchAll(/create table (?:if not exists )?public\.([a-z_]+)\s*\(([\s\S]*?)\n\);/g)) {
      for (const line of m[2].split('\n')) {
        const lm = /^\s*([a-z_][a-z0-9_]*)\s/.exec(line)
        if (!lm || SKIP.has(lm[1])) continue
        add(m[1], lm[1])
      }
    }
    for (const m of sql.matchAll(/alter table (?:if exists )?public\.([a-z_]+)([\s\S]*?);/g)) {
      for (const am of m[2].matchAll(/add column (?:if not exists )?([a-z_][a-z0-9_]*)/g)) add(m[1], am[1])
    }
  }
  return cols
}

beforeEach(() => {
  window.localStorage.clear()
  seedSpace()
})

describe('不再 select("*")', () => {
  it('通用钩子里已经没有 select("*")', () => {
    // 注释里会提到 select('*')（说明它为什么不该用），断言前先剥掉注释
    const src = read('src/lib/hooks.js')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(src).not.toMatch(/select\(\s*'\*'\s*\)/)
    // 字段来自清单表：默认按表取，调用处可覆盖
    expect(src).toMatch(/select\(columns \|\| columnsOf\(table\)\)/)
  })

  it('每张表的字段清单都只写真表里存在的列', () => {
    const real = realColumns()
    let checked = 0
    for (const [table, list] of Object.entries(LIST_COLUMNS)) {
      expect(real[table], `迁移里找不到表 ${table}`).toBeTruthy()
      for (const c of list.split(',')) {
        expect(real[table].has(c), `${table}.${c} 在迁移里不存在`).toBe(true)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(40) // 扫描本身要真的扫到东西
  })

  it('没登记的表保持 "*"（宁可多传，不可漏字段）', () => {
    expect(columnsOf('photos')).toBe(LIST_COLUMNS.photos)
    expect(columnsOf('some_unknown_table')).toBe('*')
  })

  it('分页查询发出去的确实是清单字段，且首屏窗口只有 18 条', async () => {
    boot()
    renderHook(() => usePagedCollection('photos', 'c1'))
    await waitFor(() => expect(selectsOf('photos').length).toBeGreaterThan(0))

    const q = selectsOf('photos')[0]
    expect(q.columns).toBe(LIST_COLUMNS.photos)
    expect(q.columns).not.toBe('*')
    // 渲染必需的关键字段一个都不能少
    for (const c of ['id', 'thumb_path', 'storage_path', 'deleted_at', 'author_user_id']) {
      expect(q.columns).toContain(c)
    }
    // 首屏分页：30 → 18
    expect(PAGE_SIZE).toBeGreaterThanOrEqual(15)
    expect(PAGE_SIZE).toBeLessThanOrEqual(20)
    expect(q.range).toEqual({ from: 0, to: PAGE_SIZE - 1 })
  })
})

describe('评论 / 回应 / 隐藏记录按当前页 id 过滤', () => {
  it('留言页：副表查询带 message_id in (已加载的留言 id)', async () => {
    boot()
    render(
      <StoreProvider>
        <Messages />
      </StoreProvider>,
    )
    await waitFor(() => expect(selectsOf('messages').length).toBeGreaterThan(0))

    // 隐藏记录是首屏就要用的（决定哪些留言对我不可见）→ 立刻发，且按 id 过滤
    await waitFor(() => expect(selectsOf('message_hidden').length).toBeGreaterThan(0))
    const inFilter = selectsOf('message_hidden')[0].filters.find((f) => f.op === 'in')
    expect(inFilter).toBeTruthy()
    expect(inFilter.col).toBe('message_id')
    expect(inFilter.val).toEqual(['m1'])

    // 表情回应延迟到空闲后补，同样只取当前页这些留言的
    await waitFor(() => expect(selectsOf('message_reactions').length).toBeGreaterThan(0))
    expect(selectsOf('message_reactions')[0].filters.some((f) => f.op === 'in')).toBe(true)

    // 评论点开才拉，也是按 id 过滤
    fireEvent.click(screen.getAllByText(/评论/)[0])
    await waitFor(() => expect(selectsOf('message_comments').length).toBeGreaterThan(0))
    expect(selectsOf('message_comments')[0].filters.some((f) => f.op === 'in')).toBe(true)
  })

  it('scopeFilter：没加载行 / id 太多时放弃过滤（URL 不能撑爆）', () => {
    expect(scopeFilter('message_id', [])).toBeNull()
    expect(scopeFilter('message_id', null)).toBeNull()
    // 上限内：正常给 in 过滤
    const ok = scopeFilter('message_id', ['a', 'b'])
    expect(ok).toEqual([['message_id', 'in', ['a', 'b']]])
    // 超限：返回 null，调用方改用 limit 兜底（宁可多拉不可请求失败）
    const tooMany = Array.from({ length: SCOPE_ID_LIMIT + 1 }, (_, i) => `id-${i}`)
    expect(scopeFilter('message_id', tooMany)).toBeNull()
    expect(SCOPE_FALLBACK_LIMIT).toBeGreaterThan(0)
  })
})

describe('索引：按空间和日期', () => {
  it('035 迁移覆盖 moods / pokes 与副表按主表 id 的查询', () => {
    const sql = read('supabase/migrations/035_list_query_indexes.sql')
    // 首页「只要今天的心情」：where couple_id = … and date = 今天
    expect(sql).toMatch(/create index if not exists moods_couple_date_idx\s+on public\.moods \(couple_id, date desc\)/)
    // 首页「最近一条戳一戳」：where couple_id = … order by created_at desc limit 1
    expect(sql).toMatch(/create index if not exists pokes_couple_created_idx\s+on public\.pokes \(couple_id, created_at desc\)/)
    // 副表按主表 id：前缀必须是 couple_id
    for (const t of ['message_comments', 'message_reactions', 'message_hidden']) {
      expect(sql).toMatch(new RegExp(`on public\\.${t} \\(couple_id, message_id\\)`))
    }
    expect(sql).toMatch(/on public\.diary_comments \(couple_id, diary_id\)/)
    expect(sql).toMatch(/notify pgrst/)
  })

  it('迁移编号连续，生成物同步（035 已进 schema.sql）', () => {
    const schema = read('supabase/schema.sql')
    expect(schema).toContain('moods_couple_date_idx')
    expect(schema).toContain('pokes_couple_created_idx')
  })
})
