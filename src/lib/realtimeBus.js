import { supabase } from './supabase.js'

// ============================================================
//  空间级 Realtime 总线：一个空间只订阅一个频道 space-<coupleId>
//
//  以前每个组件各建一套频道：首页一进来就同时挂着 unread / notifier /
//  poke-listener / moods / pokes 五个频道（每个都要一次 WebSocket join
//  握手），进了留言页再叠三个。现在全 App 对一个空间只有一个频道，
//  变更按「表名」分发给各组件回调，订阅/退订按回调引用计数：
//  最后一个监听者退订时才 removeChannel。
//
//  用法（和 supabase.channel 的事件对象同构，只少了 table 外的杂项）：
//    useEffect(() => subscribeTable(coupleId, 'pokes', ({ eventType, new: row, old: prev }) => …), [])
//    // 返回值直接当 effect 的清理函数
//
//  ⚠ 为什么 WATCHED_TABLES 要写死：
//    realtime-js 在 subscribe() 之后调用 .on('postgres_changes', …) 会直接
//    throw（「cannot add postgres_changes callbacks after subscribe()」），
//    所以监听必须在建频道时一次性登记完。新增表请同步加进下面两个列表，
//    tests/global-requests.test.jsx 会扫描源码里所有 useCollection 的表名兜底。
// ============================================================

// 需要联动刷新的表：useCollection / usePagedCollection / 未读中心 / 通知横幅 / 戳一戳
export const WATCHED_TABLES = [
  'messages',
  'message_comments',
  'message_reactions',
  'message_hidden',
  'diary_entries',
  'diary_comments',
  'diary_hidden',
  'photos',
  'albums',
  'delete_requests',
  'period_logs',
  'period_settings',
  'period_daily_logs',
  'pokes',
  'moods',
  'milestones',
  'members',
  // 矛盾处理室（037）：房间状态与消息都要实时同步到另一端
  'conflict_rooms',
  'conflict_room_messages',
  'conflict_room_feedback',
]

const buses = new Map() // coupleId -> { channel, handlers: Map<table, Set<cb>> }

function fanout(bus, table, payload) {
  const set = bus.handlers.get(table)
  if (!set || set.size === 0) return
  // 快照遍历：回调里可能会同步退订（切 tab / 卸载），直接遍历 Set 会漏掉或重复
  for (const cb of [...set]) {
    try {
      cb(payload)
    } catch {
      /* 一个订阅者抛错不能连累其它订阅者（通知/红点/列表各走各的） */
    }
  }
}

function createBus(coupleId) {
  const bus = { channel: null, handlers: new Map() }
  const channel = supabase.channel(`space-${coupleId}`)

  for (const table of WATCHED_TABLES) {
    // 主监听：带 couple_id 过滤，精确命中本空间的增/改/删
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter: `couple_id=eq.${coupleId}` },
      (payload) =>
        fanout(bus, table, {
          eventType: payload.eventType,
          table,
          new: payload.new,
          old: payload.old,
        }),
    )

    // 兜底监听：Postgres 的 DELETE 事件默认只带主键，服务端的 couple_id 过滤匹配
    // 不到，删除就丢了（对方要手动刷新才看得到）。这条不带过滤，客户端按旧行再判一次：
    //   · 旧行是本空间 → 上面那条已经发过了，这里跳过（否则一次删除刷两遍）
    //   · 旧行是别家空间 → 忽略
    //   · 旧行没有 couple_id（表没设 REPLICA IDENTITY FULL）→ 认不出来，保守放行
    // 005_realtime_replica.sql 给大部分表设了 FULL，但这条兜底对全部表都挂：
    // 删事件本来就稀少，宁可多刷一次也别在某个表漏设 FULL 时静默丢删除。
    channel.on('postgres_changes', { event: 'DELETE', schema: 'public', table }, (payload) => {
      const oldCoupleId = payload?.old?.couple_id
      if (oldCoupleId !== undefined) return
      fanout(bus, table, { eventType: 'DELETE', table, new: null, old: payload.old })
    })
  }

  channel.subscribe()
  bus.channel = channel
  return bus
}

/**
 * 订阅某张表的变更（走空间级共享频道）。返回退订函数，直接当 useEffect 的清理函数用。
 * 无效入参返回空函数：组件在拿到 coupleId 之前也会跑一次 effect。
 */
export function subscribeTable(coupleId, table, cb) {
  if (!coupleId || !table || typeof cb !== 'function') return () => {}
  const key = String(coupleId)
  let bus = buses.get(key)
  if (!bus) {
    bus = createBus(coupleId)
    buses.set(key, bus)
  }
  let set = bus.handlers.get(table)
  if (!set) {
    set = new Set()
    bus.handlers.set(table, set)
  }
  set.add(cb)

  return () => {
    const cur = buses.get(key)
    if (!cur) return
    const s = cur.handlers.get(table)
    if (!s) return
    s.delete(cb)
    if (s.size > 0) return
    cur.handlers.delete(table)
    // 没有任何人听了 → 整个频道撤掉（换空间 / 退出时不再空转挂着）
    if (cur.handlers.size === 0) {
      buses.delete(key)
      supabase.removeChannel(cur.channel)
    }
  }
}

// ---------- 测试/排障用 ----------
/**
 * 当前活着的共享频道：[{ coupleId, tables, listeners }]
 * listeners 是每张表当前的订阅者个数：隐藏 tab 摘掉订阅后它会掉下来
 *（频道本身还在 —— 只要还有别人在听，就不该为一个 tab 拆掉整条连接）。
 */
export function activeBuses() {
  return [...buses.entries()].map(([coupleId, bus]) => ({
    coupleId,
    tables: [...bus.handlers.keys()].sort(),
    listeners: Object.fromEntries([...bus.handlers].map(([table, set]) => [table, set.size])),
  }))
}

/** 测试之间清干净（换空间/重新登录时总线必须重建） */
export function resetBus() {
  for (const bus of buses.values()) bus.channel && supabase.removeChannel(bus.channel)
  buses.clear()
}
