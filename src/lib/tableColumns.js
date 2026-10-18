// ============================================================
//  列表查询的字段清单：通用钩子不再 select('*')
//
//  为什么要这张表：
//    select('*') 会把表里所有列都拉下来，包括用不上的大字段（text[]、长文本）。
//    手机上列表一屏十几行，多出来的列既吃流量又拖解析；而且以后再加列（例如
//    photos 的某个新属性），前端会**静默**开始多传数据，谁也不会注意到。
//    现在改成显式清单：页面要用哪个字段，就写在这里，加列不再自动生效。
//
//  用法：hooks.js 的 useCollection / usePagedCollection / useLatestRow 默认按这里取；
//        某个页面确实要多几列，就在调用处传 columns 覆盖（别改这张表，会影响别人）。
//
//  维护纪律：
//    · 这里每一行都必须是「前端真的会读」的字段，不要为了省事整表照抄；
//    · 缺字段的症状是「界面某一块变空/报错」，加回来即可，不会损坏数据；
//    · 测试 tests/list-columns.test.jsx 会扫这张表 + 各页面的调用，字段名写错会红。
// ============================================================

// 副表（评论/回应/隐藏记录）按「当前页已加载的主表 id」过滤时，
// 超过这个条数就放弃过滤 —— PostgREST 的 in.() 是拼在 URL 里的，
// 几百个 uuid 会把请求行撑到网关拒收。放弃过滤时调用方改用 limit 兜底。
export const SCOPE_ID_LIMIT = 120

// 放弃 id 过滤后副表的兜底上限：宁可多拉一点，也不要把整个历史全拉下来
export const SCOPE_FALLBACK_LIMIT = 300

/** 每张表「列表场景」需要的字段。没登记的表仍走 '*'（宁可多传不可漏字段） */
export const LIST_COLUMNS = {
  // 照片墙 / 回收站 / 图集导出：只要渲染与判定需要的列，不要整行原数据
  photos:
    'id,couple_id,created_at,caption,storage_path,thumb_path,original_path,album_id,pinned_at,deleted_at,deleted_by,author_user_id',
  albums: 'id,couple_id,name,description,created_at,deleted_at,deleted_by',
  delete_requests:
    'id,couple_id,kind,ref_ids,label,purge,requester_user_id,responder_user_id,status,created_at,resolved_at',

  // 留言流：正文 + 图片/语音路径 + 回复指向；couple_id 留给未读/通知链路
  messages: 'id,couple_id,created_at,content,image_path,voice_path,voice_seconds,reply_to,author_user_id',
  message_comments: 'id,couple_id,message_id,author_user_id,content,created_at',
  message_reactions: 'id,couple_id,message_id,user_id,emoji,created_at',
  message_hidden: 'id,couple_id,message_id,user_id,permanent,created_at',

  // 日记流：正文 + 图片数组 + 心情 + 软删标记
  diary_entries: 'id,couple_id,created_at,content,mood,images,deleted_at,author_user_id',
  diary_comments: 'id,couple_id,diary_id,author_user_id,content,created_at',
  diary_hidden: 'id,couple_id,diary_id,user_id,created_at',

  // 心情按天查（首页只查今天），戳一戳只要最近一条：都用得上 kind / date
  moods: 'id,couple_id,user_id,mood,note,date,created_at',
  pokes: 'id,couple_id,from_user_id,kind,created_at',

  // 生理期：三张表都不大，但同样只取用到的列
  period_logs: 'id,couple_id,start_date,created_by,created_at',
  // ⚠ period_settings 的主键就是 couple_id，表里**没有 id 列**：PostgREST 查不存在的
  //   列会直接报 42703（整条查询失败），所以这里绝不能写 id
  period_settings: 'couple_id,cycle_len,period_len,updated_at',
  period_daily_logs:
    'id,couple_id,user_id,log_date,flow,pain,mood,symptoms,note,created_at,updated_at',

  // 矛盾处理室（037）：房间列表 / 房间内消息 / 结束后的复盘状态。
  // 房间表不带正文，消息表只有 body —— 两端都只取要渲染的字段。
  conflict_rooms:
    'id,couple_id,created_by,invited_user_id,status,turn_user_id,duration_seconds,invite_note,invite_expires_at,started_at,expires_at,end_requested_by,ended_at,created_at',
  conflict_room_messages: 'id,room_id,couple_id,sender_user_id,body,client_msg_id,created_at',
  conflict_room_feedback: 'id,room_id,couple_id,user_id,status,created_at',
}

/** 取表的默认字段串；没登记的表保持 '*'（安全默认值） */
export function columnsOf(table) {
  return LIST_COLUMNS[table] || '*'
}

/**
 * 把「当前页已加载的主表 id」变成副表的 in 过滤条件。
 * 评论 / 回应 / 隐藏记录只跟屏幕上这些行有关，没必要整表拉。
 * @returns {Array|null} null = 不按 id 过滤（没加载任何行，或 id 太多会撑爆 URL）
 */
export function scopeFilter(col, ids) {
  if (!ids || ids.length === 0 || ids.length > SCOPE_ID_LIMIT) return null
  return [[col, 'in', ids]]
}
