/**
 * 测试用的 supabase 模块替身：vitest 通过 alias 把 `src/lib/supabase.js` 指到这里，
 * 业务代码无需任何改动就跑在内存数据库上。
 *
 * 每个测试文件有独立的模块图，所以这里的单例只在本文件内共享；
 * 用例之间用 resetSupabase() 重置数据、失败注入与调用日志。
 */
import { createSupabaseStub } from './supabase-stub.js'

const ctx = createSupabaseStub({})

/** 与 src/lib/supabase.js 同名的导出：业务代码 import { supabase } 拿到的就是它 */
export const supabase = ctx.client

/** 直接读写内存表：stub.db.photos / stub.db.delete_requests … */
export const stub = ctx.stub

/** 失败注入与 realtime 控制：sbApi.failUpdate('photos')、sbApi.emit('photos', {...}) */
export const sbApi = ctx.api

/** 用例开始时重置到干净状态 */
export function resetSupabase({ db = {}, files = [] } = {}) {
  for (const k of Object.keys(stub.db)) delete stub.db[k]
  Object.assign(stub.db, JSON.parse(JSON.stringify(db)))
  stub.files.clear()
  files.forEach((f) => stub.files.add(f))
  stub.failures = {}
  stub.rpcHandlers = {}
  ctx.api.resetLog()
  stub.channels.clear()
}

export { createSupabaseStub }
