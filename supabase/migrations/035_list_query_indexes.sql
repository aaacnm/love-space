-- ============================================================
--  035_list_query_indexes.sql · 列表查询索引：按空间 + 日期 / 按主表 id 的复合索引
--
--  顺序要求：必须在 003/004/014/017/019/027 之后（索引建在这些表上）；不跑功能正常，只是全表扫描
--  依赖迁移：001, 003, 004, 014, 017, 019, 027
--  幂等：是，可重复执行（全部使用 if not exists）
--
--  fingerprint: exists (select 1 from pg_indexes where schemaname='public' and indexname='moods_couple_date_idx')
--  check: moods_couple_date_idx 索引已存在
-- ============================================================

-- 为什么要有它：
--   前端的列表查询已经收窄成三种形态：
--     ① 主表分页：where couple_id = … order by created_at desc limit 18   → 032 已建复合索引
--     ② 心情按天：where couple_id = … and date = 'YYYY-MM-DD'             → 本文件的 moods 索引
--     ③ 副表按主表 id：where couple_id = … and message_id in (…)         → 本文件的 comments / reactions / hidden 索引
--   没有对应索引时，② ③ 都是全表扫描：空间里攒了几千条戳一戳之后，
--   「今天的心情」这种两行的查询也会把整张表翻一遍。
--
-- ⚠ 前置：请确认 032_paged_indexes.sql 已经在生产库跑过（它建的是 (couple_id, created_at)
--   复合索引，主表分页全靠它）。下面这条 SQL 可以直接核对，期望返回 4 行：
--     select indexname from pg_indexes
--     where schemaname = 'public'
--       and indexname in ('photos_couple_created_idx','messages_couple_created_idx',
--                         'diary_entries_couple_created_idx','period_logs_couple_created_idx');

set lock_timeout = '8s';

-- ---------- ① 按空间 + 日期：首页只查「今天的心情」 ----------
-- moods 的 unique 是 (couple_id, user_id, date)，按 date 过滤时前缀命不中（第二列是 user_id），
-- 所以要单独建一个 (couple_id, date) 的索引
create index if not exists moods_couple_date_idx
  on public.moods (couple_id, date desc);

-- ---------- ② 按空间 + 时间：戳一戳（首页只取最近一条，历史展开才翻） ----------
create index if not exists pokes_couple_created_idx
  on public.pokes (couple_id, created_at desc);

-- ---------- ③ 副表按主表 id：评论 / 回应 / 隐藏记录 ----------
-- 前端改成「只取当前页已加载的那些主表行」之后，查询形如
--   where couple_id = … and message_id in (…18 个 id…)
-- 前缀必须是 couple_id（RLS + 显式过滤都带它），第二列才是 message_id / diary_id。
create index if not exists message_comments_couple_message_idx
  on public.message_comments (couple_id, message_id);
create index if not exists message_reactions_couple_message_idx
  on public.message_reactions (couple_id, message_id);
create index if not exists message_hidden_couple_message_idx
  on public.message_hidden (couple_id, message_id);
create index if not exists diary_comments_couple_diary_idx
  on public.diary_comments (couple_id, diary_id);
create index if not exists diary_hidden_couple_diary_idx
  on public.diary_hidden (couple_id, diary_id);

-- ---------- ④ 相册列表：按空间 + 创建时间正序 ----------
create index if not exists albums_couple_created_idx
  on public.albums (couple_id, created_at);

-- 让 PostgREST 立刻看见新对象（不然要等 schema cache 自己刷新）
notify pgrst, 'reload schema';
