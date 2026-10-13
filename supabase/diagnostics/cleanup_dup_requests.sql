-- ============================================================
-- 清理重复的「待确认」删除请求
--
-- 背景：发起端此前没有防重，同一批照片/图集可能被发了多条
-- pending 请求，接收方页面上会挂出好几条一样的「等你确认」。
-- 前端已加防重 + 失效过滤，本脚本把库里已有的重复行清掉
-- （同一批对象只保留最早的一条 pending）。
--
-- 在 Supabase Dashboard → SQL Editor 执行（只动 pending 行，
-- 已同意/已拒绝的历史记录不受影响）。
-- ============================================================

-- 先看一眼要清哪些（只读）
select a.id, a.kind, a.ref_ids, a.requester_user_id, a.created_at
from public.delete_requests a
join public.delete_requests b
  on a.status = 'pending'
 and b.status = 'pending'
 and a.kind = b.kind
 and a.ref_ids && b.ref_ids
 and (a.created_at > b.created_at or (a.created_at = b.created_at and a.id > b.id))
order by a.created_at;

-- 确认无误后执行清理：
-- delete from public.delete_requests a
-- using public.delete_requests b
-- where a.status = 'pending'
--   and b.status = 'pending'
--   and a.kind = b.kind
--   and a.ref_ids && b.ref_ids
--   and (a.created_at > b.created_at or (a.created_at = b.created_at and a.id > b.id));
