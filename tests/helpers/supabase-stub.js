/**
 * 内存版 Supabase 客户端：给 Vitest 用的测试替身。
 *
 * 为什么要自己写而不是连真库：这些用例测的是「前端在各种失败/时序下的行为」——
 * 双人审批、入库失败回滚、删除兜底过滤……真库既跑不出错误注入，也会让测试变慢变脆。
 *
 * 能力：
 *   - 表查询：select / insert / update / delete + eq / neq / gt / in / is / order / range / limit / single
 *   - count 查询：select('id', { count: 'exact', head: true })
 *   - rpc(name, args)：默认按注入的 handler 执行（可模拟事务），支持失败注入
 *   - storage：upload / remove / createSignedUrl(s)，删除与上传都可失败注入
 *   - realtime：channel().on().subscribe()，emit() 模拟服务端推事件，removeChannel 记录
 *   - 失败注入：failInsert / failUpdate / failDelete / failRpc / failUpload / failRemove
 *   所有调用都有日志（stub.log.*），断言既看数据也看「发过什么请求」。
 */

import { getToastItems } from '../../src/lib/toast.jsx'

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)))

function makeQuery(stub, table) {
  let op = 'select'
  let insertRows = null
  let patch = null
  let selectCols = null
  let countMode = null
  let headOnly = false
  let wantSingle = false
  let wantMaybeSingle = false
  const filters = []
  const orders = []
  let rangeCfg = null
  let limitN = null

  const q = {}
  const chain = (fn) => {
    q[fn] = (...args) => {
      if (fn === 'select') {
        // update().select() 不改变操作类型；只记录要回读的字段
        if (op !== 'insert' && op !== 'update' && op !== 'delete') op = 'select'
        const [cols, opts] = args
        selectCols = cols
        if (opts?.count) countMode = opts.count
        if (opts?.head) headOnly = true
      } else if (fn === 'insert') {
        op = 'insert'
        insertRows = args[0]
      } else if (fn === 'update') {
        op = 'update'
        patch = args[0]
      } else if (fn === 'delete') {
        op = 'delete'
      } else if (fn === 'eq') {
        filters.push({ op: 'eq', col: args[0], val: args[1] })
      } else if (fn === 'neq') {
        filters.push({ op: 'neq', col: args[0], val: args[1] })
      } else if (fn === 'gt') {
        filters.push({ op: 'gt', col: args[0], val: args[1] })
      } else if (fn === 'gte') {
        filters.push({ op: 'gte', col: args[0], val: args[1] })
      } else if (fn === 'lt') {
        filters.push({ op: 'lt', col: args[0], val: args[1] })
      } else if (fn === 'in') {
        filters.push({ op: 'in', col: args[0], val: args[1] || [] })
      } else if (fn === 'is') {
        // .is('deleted_at', null)：undefined 也当作 null（stub 行常常没这个字段）
        filters.push({ op: 'is', col: args[0], val: args[1] })
      } else if (fn === 'order') {
        orders.push({ col: args[0], ascending: !!args[1]?.ascending })
      } else if (fn === 'range') {
        rangeCfg = { from: args[0], to: args[1] }
      } else if (fn === 'limit') {
        limitN = args[0]
      } else if (fn === 'single') {
        wantSingle = true
      } else if (fn === 'maybeSingle') {
        wantMaybeSingle = true
      } else if (fn === 'filter' || fn === 'or') {
        /* 未用到的过滤器：忽略，保持链可用 */
      }
      return q
    }
  }
  ;['select', 'insert', 'update', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'in', 'is', 'order', 'range', 'limit', 'single', 'maybeSingle', 'filter', 'or'].forEach(chain)

  const matchRow = (row) =>
    filters.every((f) => {
      const v = row[f.col]
      switch (f.op) {
        case 'eq':
          return v === f.val
        case 'neq':
          return v !== f.val
        case 'gt':
          return v != null && v > f.val
        case 'gte':
          return v != null && v >= f.val
        case 'lt':
          return v != null && v < f.val
        case 'in':
          return Array.isArray(f.val) && f.val.includes(v)
        case 'is':
          return f.val === null ? v === null || v === undefined : v === f.val
        default:
          return true
      }
    })

  const rowsOf = () => (stub.db[table] || []).filter(matchRow)

  const sortRows = (rows) => {
    if (orders.length === 0) return rows
    const out = [...rows]
    out.sort((a, b) => {
      for (const o of orders) {
        const av = a[o.col]
        const bv = b[o.col]
        if (av === bv) continue
        const cmp = av > bv ? 1 : -1
        return o.ascending ? cmp : -cmp
      }
      return 0
    })
    return out
  }

  async function run() {
    // 一次性失败（__once）取走即失效：用来测「第一次失败、重试成功」这类分支
    const tableFail = (kind) => {
      const key = `${kind}:${table}`
      const f = stub.failures[key]
      if (f?.__once) delete stub.failures[key]
      return f || null
    }

    if (op === 'select') {
      // columns / limit / range 也记下来：
      // 「只查需要的字段」「只查一条」「只查一页」这类优化靠它断言
      stub.log.select.push({
        table,
        columns: selectCols,
        filters: clone(filters),
        limit: limitN,
        range: rangeCfg ? { ...rangeCfg } : null,
      })
      if (!stub.db[table]) stub.db[table] = []
      let rows = sortRows(rowsOf())
      if (rangeCfg) rows = rows.slice(rangeCfg.from, rangeCfg.to + 1)
      if (limitN != null) rows = rows.slice(0, limitN)
      if (countMode) return { data: headOnly ? null : clone(rows), count: rowsOf().length, error: null }
      if (wantSingle) return { data: rows[0] ? clone(rows[0]) : null, error: null }
      if (wantMaybeSingle) return { data: rows[0] ? clone(rows[0]) : null, error: null }
      return { data: clone(rows), error: null }
    }

    if (op === 'insert') {
      const fail = tableFail('insert')
      if (fail) {
        stub.log.insert.push({ table, rows: clone(insertRows), error: fail })
        return { data: null, error: fail }
      }
      const arr = Array.isArray(insertRows) ? insertRows : [insertRows]
      const inserted = arr.map((r) => {
        const clean = Object.fromEntries(Object.entries(r || {}).filter(([, v]) => v !== undefined))
        return { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...clean }
      })
      stub.db[table] = [...(stub.db[table] || []), ...inserted]
      stub.log.insert.push({ table, rows: clone(inserted) })
      if (wantSingle) return { data: clone(inserted[0]), error: null }
      return { data: clone(inserted), error: null }
    }

    if (op === 'update') {
      const fail = tableFail('update')
      if (fail) {
        stub.log.update.push({ table, patch: clone(patch), filters: clone(filters), error: fail })
        return { data: null, error: fail }
      }
      const touched = []
      stub.db[table] = (stub.db[table] || []).map((row) => {
        if (!matchRow(row)) return row
        const next = { ...row, ...patch }
        touched.push(next)
        return next
      })
      stub.log.update.push({ table, patch: clone(patch), filters: clone(filters), touched: touched.map((r) => r.id) })
      if (selectCols) {
        if (wantSingle) return { data: touched[0] ? clone(touched[0]) : null, error: null }
        return { data: clone(touched), error: null }
      }
      return { data: null, error: null }
    }

    if (op === 'delete') {
      const fail = tableFail('delete')
      if (fail) {
        stub.log.delete.push({ table, filters: clone(filters), error: fail })
        return { data: null, error: fail }
      }
      const keep = []
      const gone = []
      for (const row of stub.db[table] || []) (matchRow(row) ? gone : keep).push(row)
      stub.db[table] = keep
      stub.log.delete.push({ table, filters: clone(filters), removed: gone.map((r) => r.id) })
      if (selectCols) return { data: clone(gone), error: null }
      return { data: null, error: null }
    }

    return { data: null, error: null }
  }

  // 查询对象是 thenable：业务代码里 `await supabase.from(x).select()...` 直接可用
  q.then = (onFul, onRej) => run().then(onFul, onRej)
  q.catch = (onRej) => run().catch(onRej)
  q.finally = (fn) => run().finally(fn)
  return q
}

export function createSupabaseStub({ db = {}, files = [] } = {}) {
  let channelSeq = 0
  const stub = {
    db,
    files: new Set(files), // storage 里「存在」的文件路径
    failures: {}, // 'insert:photos' / 'rpc:approve_delete_request' 等
    rpcHandlers: {},
    // 登录态：session 供 getSession（本地恢复）用，authUser 供 getUser（联网校验）用
    session: null,
    authUser: null,
    anonUser: null,
    log: {
      select: [],
      insert: [],
      update: [],
      delete: [],
      rpc: [],
      auth: [],
      upload: [],
      remove: [],
      sign: [],
      broadcast: [],
    },
    channels: new Map(),
    removedChannels: [],
  }

  // ---------- 失败注入 ----------
  const err = (msg, once) => (once ? { message: msg, __once: true } : { message: msg })
  const api = {
    failInsert: (table, msg = 'insert failed', once = false) =>
      (stub.failures[`insert:${table}`] = err(msg, once)),
    failUpdate: (table, msg = 'update failed', once = false) =>
      (stub.failures[`update:${table}`] = err(msg, once)),
    failDelete: (table, msg = 'delete failed', once = false) =>
      (stub.failures[`delete:${table}`] = err(msg, once)),
    failRpc: (name, msg = 'rpc failed', once = false) => (stub.failures[`rpc:${name}`] = err(msg, once)),
    failUpload: (msg = 'upload failed', once = false) => (stub.failures['storage:upload'] = err(msg, once)),
    failRemove: (msg = 'remove failed', once = false) => (stub.failures['storage:remove'] = err(msg, once)),
    failSign: (msg = 'sign failed', once = false) => (stub.failures['storage:sign'] = err(msg, once)),
    clearFailures: () => {
      stub.failures = {}
    },
    /** 自定义 RPC 行为（例如审批事务：改状态 + 软删），返回值即 { data, error } */
    onRpc: (name, fn) => {
      stub.rpcHandlers[name] = fn
    },
    resetLog: () => {
      for (const k of Object.keys(stub.log)) stub.log[k] = []
      stub.removedChannels = []
    },
    // ---------- realtime ----------
    /** 模拟服务端推送：命中 table + 事件类型 + couple_id 过滤器的回调都会被调用 */
    emit(table, payload) {
      const fired = []
      for (const ch of stub.channels.values()) {
        for (const h of ch.handlers) {
          if (h.table !== table) continue
          if (h.event !== '*' && h.event !== payload.eventType) continue
          if (h.filter) {
            const m = /^(\w+)=eq\.(.+)$/.exec(h.filter)
            if (m) {
              const row = payload.new || payload.old || {}
              if (row[m[1]] !== m[2]) continue
            }
          }
          h.cb(payload)
          fired.push(h)
        }
      }
      return fired.length
    },
    /** 当前还活着的频道（同名多实例会重复出现多次） */
    activeChannels: () => [...stub.channels.values()].map((c) => c.name),
    removedChannelCount: () => stub.removedChannels.length,
    // ---------- 登录态 ----------
    /** 预设已登录用户：同时作用于 getSession（本地恢复）与 getUser（联网校验） */
    setUser: (u) => {
      stub.session = u ? { user: u } : null
      stub.authUser = u || null
    },
    /** 让 getUser 返回 null（模拟会话过期/被吊销），getSession 仍保留旧值 */
    expireSession: () => {
      stub.authUser = null
    },
    /** signInAnonymously 会返回的用户（默认 anon-1） */
    setAnonUser: (u) => {
      stub.anonUser = u
    },
    /** 认证调用流水：['getSession', 'getUser', 'signInAnonymously', …] */
    authCalls: () => stub.log.auth,
  }

  const takeFail = (key) => {
    const f = stub.failures[key]
    if (f?.__once) delete stub.failures[key]
    return f || null
  }

  const storageFrom = (bucket) => ({
    async upload(path, file, opts) {
      stub.log.upload.push({ bucket, path, opts })
      const fail = takeFail('storage:upload')
      if (fail) return { data: null, error: fail }
      stub.files.add(path)
      return { data: { path }, error: null }
    },
    async remove(paths) {
      const list = Array.isArray(paths) ? paths : [paths]
      stub.log.remove.push({ bucket, paths: [...list] })
      const rmFail = takeFail('storage:remove')
      if (rmFail) return { data: null, error: rmFail }
      list.forEach((p) => stub.files.delete(p))
      return { data: list.map((p) => ({ path: p })), error: null }
    },
    async createSignedUrl(path, ttl, opts) {
      stub.log.sign.push({ bucket, path, ttl, opts })
      const sFail = takeFail('storage:sign')
      if (sFail) return { data: null, error: sFail }
      // 带变换的地址要真的带上变换参数：真实的 Storage 变换 URL 就是这样，
      // 也才能验证「480 缩略图」和「原尺寸」是两条不同的缓存
      const tf = opts?.transform
        ? new URLSearchParams(Object.entries(opts.transform).map(([k, v]) => [k, String(v)])).toString()
        : ''
      return {
        data: { signedUrl: `https://sign.test/${bucket}/${path}?token=1${tf ? `&${tf}` : ''}` },
        error: null,
      }
    },
    async createSignedUrls(paths, ttl) {
      stub.log.sign.push({ bucket, paths: [...paths], ttl })
      const sFail = takeFail('storage:sign')
      if (sFail) return { data: null, error: sFail }
      return {
        data: paths.map((p) => ({ path: p, signedUrl: `https://sign.test/${bucket}/${p}?token=1` })),
        error: null,
      }
    },
    getPublicUrl(path) {
      return { data: { publicUrl: `https://public.test/${bucket}/${path}` } }
    },
  })

  const client = {
    from: (table) => makeQuery(stub, table),
    async rpc(name, args = {}) {
      stub.log.rpc.push({ name, args: clone(args) })
      const fail = takeFail(`rpc:${name}`)
      if (fail) return { data: null, error: fail }
      const handler = stub.rpcHandlers[name]
      if (handler) return await handler(args)
      return { data: null, error: null }
    },
    storage: {
      url: 'https://storage.test',
      from: storageFrom,
    },
    // 同一频道名允许存在多个实例（共同播放器里「两个人」各订阅一次）。
    // 所以 Map 按内部自增 id 存，delete/清理只影响自己那一个。
    channel(name) {
      const id = `${name}#${++channelSeq}`
      const ch = { id, name, handlers: [], broadcasts: [], status: 'SUBSCRIBED' }
      stub.channels.set(id, ch)
      const self = {
        id,
        name,
        on: (type, cfg, cb) => {
          if (type === 'postgres_changes') {
            ch.handlers.push({ event: cfg.event, table: cfg.table, filter: cfg.filter, cb })
          } else if (type === 'broadcast') {
            ch.broadcasts.push({ event: cfg.event, cb })
          }
          return self
        },
        // broadcast：投递给「同名房间的其他实例」，不回环给自己
        // （对齐 Realtime 公共频道的 self:false 语义）
        send: (msg) => {
          if (msg?.type === 'broadcast') {
            const hit = []
            for (const other of stub.channels.values()) {
              if (other.id === id || other.name !== name) continue
              for (const h of other.broadcasts) {
                if (h.event === msg.event) {
                  hit.push(h)
                  h.cb({ payload: msg.payload })
                }
              }
            }
            stub.log.broadcast.push({ name, event: msg.event, payload: clone(msg.payload), reached: hit.length })
          }
          return Promise.resolve('ok')
        },
        subscribe: () => {
          ch.status = 'SUBSCRIBED'
          return self
        },
        unsubscribe: () => self,
      }
      return self
    },
    removeChannel(ch) {
      let key = null
      if (ch && typeof ch === 'object' && ch.id && stub.channels.has(ch.id)) key = ch.id
      const wantName = typeof ch === 'string' ? ch : ch?.name
      if (key == null) {
        for (const [k, v] of stub.channels) {
          if (v.name === wantName) {
            key = k
            break
          }
        }
      }
      if (key == null) return
      stub.channels.delete(key)
      stub.removedChannels.push(wantName)
    },
    auth: {
      // 本地恢复：不发网络请求（真实实现从 localStorage 读）
      async getSession() {
        stub.log.auth.push('getSession')
        const s = stub.session
        return { data: { session: s ? { user: s.user, access_token: 'stub' } : null }, error: null }
      },
      // 联网校验：比 getSession 权威，能刷新过期 token
      async getUser() {
        stub.log.auth.push('getUser')
        return { data: { user: stub.authUser || null }, error: null }
      },
      async signInAnonymously() {
        stub.log.auth.push('signInAnonymously')
        const u = stub.anonUser || { id: 'anon-1', is_anonymous: true }
        stub.session = { user: u }
        stub.authUser = u
        return { data: { user: u, session: { user: u } }, error: null }
      },
    },
  }

  return { client, stub, api }
}

/** 常用：把当前 toast 文案取出来断言（toast 是模块单例，跨组件可观测） */
export function toastTexts() {
  return getToastItems().map((t) => t.text)
}

/** 场景之间清空提示，避免上一条用例的 toast 混进下一个断言 */
export function clearToasts() {
  globalThis.__TOAST__?.clear()
}
