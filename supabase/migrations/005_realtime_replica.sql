-- ============================================================
--  005_realtime_replica.sql · 实时同步修复：删除事件带上完整旧记录
--
--  顺序要求：必须在所有会用到 DELETE 监听的表建完之后；新增表要在对应迁移里各自设 REPLICA IDENTITY FULL
--  依赖迁移：001, 004
--  幂等：是，可重复执行（全部使用 if not exists / create or replace）
--
--  fingerprint: exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relname='photos' and c.relreplident='f')
--  check: public.photos 已是 REPLICA IDENTITY FULL
-- ============================================================

-- ============================================================
--  实时同步修复：删除操作对方不刷新也能立刻消失
--
--  问题：Postgres 的 logical replication 在 DELETE 时默认只发送主键
--        （REPLICA IDENTITY DEFAULT），所以 Realtime 里的
--        filter: couple_id=eq.<id> 匹配不到删除事件，消息被服务端丢掉，
--        对方只能手动刷新才看得到日记/照片等被删掉。
--
--  解决：把表设为 REPLICA IDENTITY FULL，DELETE/UPDATE 的旧记录会带上
--        所有列，couple_id 过滤即可正常命中。
--
--  用法：Supabase 后台 -> SQL Editor -> 新建查询 -> 全选粘贴 -> Run
-- ============================================================

alter table public.members            replica identity full;
alter table public.milestones         replica identity full;
alter table public.diary_entries      replica identity full;
alter table public.diary_comments     replica identity full;
alter table public.diary_hidden       replica identity full;
alter table public.photos             replica identity full;
alter table public.wishes             replica identity full;
alter table public.messages           replica identity full;
alter table public.timeline_events    replica identity full;
alter table public.pokes              replica identity full;
alter table public.moods              replica identity full;

-- 校验：下面这条查询应返回上面所有表的 relreplident = 'f'
-- select relname, relreplident from pg_class
--  where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname;
