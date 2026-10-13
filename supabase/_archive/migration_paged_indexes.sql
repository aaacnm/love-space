-- 分页性能索引：三大内容表按 (couple_id, created_at) 复合索引，
-- 支撑 usePagedCollection 的「WHERE couple_id ORDER BY created_at DESC LIMIT n」分页查询
-- 与留言/日记的月/日筛选。评论表与生理期日志同构顺手覆盖。
-- 跑法：Supabase Dashboard → SQL Editor 全量执行（幂等，可重复跑）。

set lock_timeout = '8s';

-- 主内容表：倒序查询（最新在前）
create index if not exists photos_couple_created_idx
  on public.photos (couple_id, created_at desc);
create index if not exists messages_couple_created_idx
  on public.messages (couple_id, created_at desc);
create index if not exists diary_entries_couple_created_idx
  on public.diary_entries (couple_id, created_at desc);
create index if not exists period_logs_couple_created_idx
  on public.period_logs (couple_id, created_at desc);

-- 评论表：正序（asc）展示，普通索引即可（Postgres 可反向扫描）
create index if not exists message_comments_couple_created_idx
  on public.message_comments (couple_id, created_at);
create index if not exists diary_comments_couple_created_idx
  on public.diary_comments (couple_id, created_at);
